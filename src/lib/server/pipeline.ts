import { mkdir, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { Settings } from '$lib/settings';
import type { ArtSource, JobState, MetadataSource, TrackState } from '$lib/types';
import { resolveAlbum, type SourceTrack } from './album';
import { parseArtistField } from './artists';
import { artCandidates, prepareCover } from './artwork';
import { createBackupUnlocked, recordCurrentPaths } from './backups';
import {
	audioFilesIn,
	destinationFor,
	libraryRoot,
	placeUnlocked,
	removeEmptyDirs,
	withLibraryLock
} from './library';
import type { Tags } from './tags';
import { extractCover, probeFile, verify, writeTags } from './tagging';
import { normalize } from './text';
import { download, type ResolvedEntry, type YtInfo } from './ytdlp';

export type Slot = <T>(fn: () => Promise<T>) => Promise<T>;

interface Ctx {
	job: JobState;
	settings: Settings;
	workDir: string;
	update: () => void;
	slot: Slot;
}

interface Item {
	track: TrackState;
	source: SourceTrack;
	audioPath: string;
	fallbackArt?: { source: ArtSource; path: string };
	/** Re-tag only: the file in the library and its tags before we touched it. */
	original?: { abs: string; tags: Record<string, string> };
}

function fail(track: TrackState, err: unknown) {
	track.status = 'failed';
	track.error = err instanceof Error ? err.message : String(err);
}

function sourceFromYouTube(key: string, info: YtInfo, seq: number, albumIndex?: number): SourceTrack {
	const artists = info.artists?.length
		? info.artists
		: parseArtistField(info.artist ?? info.uploader?.replace(/ - Topic$/, ''));
	return {
		key,
		title: info.track ?? info.title ?? key,
		artists,
		album: info.album,
		year: info.release_year?.toString() ?? info.release_date?.slice(0, 4),
		durationSec: info.duration,
		position: albumIndex,
		seq,
		// Music tracks carry a "track" field; plain uploads (lyric/official videos) don't.
		fromVideo: !info.track
	};
}

function sourceFromFile(key: string, abs: string, tags: Record<string, string>, durationSec: number | undefined, seq: number): SourceTrack {
	const stem = basename(abs, extname(abs));
	const fileNumber = /^(?:\d+-)?(\d{1,3})[.\s-]/.exec(stem)?.[1];
	const artists = parseArtistField(tags.artist);
	return {
		key,
		// "03. Title" filenames are the fallback when the file has no title tag.
		title: tags.title || stem.replace(/^(?:\d+-)?\d{1,3}[.\s-]+\s*/, ''),
		artists: artists.length ? artists : parseArtistField(tags.album_artist),
		album: tags.album || basename(dirname(abs)),
		year: tags.date?.slice(0, 4),
		genre: tags.genre,
		durationSec,
		position: Number.parseInt(tags.track ?? '', 10) || (fileNumber ? Number(fileNumber) : undefined),
		trackCount: Number.parseInt(tags.track?.split('/')[1] ?? '', 10) || undefined,
		disc: Number.parseInt(tags.disc ?? '', 10) || undefined,
		seq
	};
}

const trackField = (t: Tags) =>
	t.trackNumber ? `${t.trackNumber}${t.trackCount ? `/${t.trackCount}` : ''}` : undefined;

/** "Field: old → new" lines for the re-tag report. */
function describeChanges(old: Record<string, string>, t: Tags, oldPath: string, newPath: string): string[] {
	const rows: [string, string | undefined, string | undefined][] = [
		['Title', old.title, t.title],
		['Artist', old.artist, t.artist],
		['Album artist', old.album_artist, t.albumArtist],
		['Album', old.album, t.album],
		['Track', old.track, trackField(t)],
		['Year', old.date, t.year]
	];
	const out = rows
		.filter(([, a, b]) => (a ?? '').trim() !== (b ?? '').trim())
		.map(([label, a, b]) => `${label}: ${a || '(none)'} → ${b || '(none)'}`);
	if (oldPath !== newPath) out.push(`File: ${oldPath} → ${newPath}`);
	return out;
}

/** Match → cover → write + verify for one album. Returns the finished temp files. */
async function tagGroup(
	ctx: Ctx,
	items: Item[],
	groupNo: number,
	fallbackSource: MetadataSource,
	knownTrackCount?: number
): Promise<Map<Item, { out: string; tags: Tags }>> {
	const done = new Map<Item, { out: string; tags: Tags }>();
	const { job, settings, update } = ctx;
	const dir = join(ctx.workDir, `album-${groupNo}`);
	await mkdir(dir, { recursive: true });

	for (const it of items) it.track.status = 'tagging';
	update();

	const resolved = await resolveAlbum(
		items.map((i) => i.source),
		{ fallbackSource, contact: settings.mbContact, knownTrackCount }
	);
	job.albums.push(resolved.match);
	update();

	const cover = join(dir, 'cover.jpg');
	const firstTags = resolved.tags.get(items[0].source.key);
	resolved.match.artSource = await prepareCover(
		artCandidates({
			dir,
			size: settings.artSize,
			artist: resolved.match.albumArtist,
			album: resolved.match.album,
			title: firstTags?.title,
			fallbacks: items.flatMap((i) => (i.fallbackArt ? [i.fallbackArt] : []))
		}),
		cover,
		settings.artSize
	);
	if (!resolved.match.artSource) {
		for (const it of items) fail(it.track, 'Could not get album art from any source.');
		return done;
	}

	await Promise.all(
		items.map((it, i) =>
			ctx.slot(async () => {
				try {
					const tags = resolved.tags.get(it.source.key)!;
					const out = join(dir, `${i}.m4a`);
					await writeTags(it.audioPath, cover, tags, out);
					let v = await verify(out, tags);
					if (!v.artOk || v.mismatched.length) {
						await writeTags(it.audioPath, cover, tags, out);
						v = await verify(out, tags);
					}
					if (!v.artOk) throw new Error('Album art did not verify after writing.');
					if (v.mismatched.length) it.track.warnings.push(`Tags did not verify: ${v.mismatched.join(', ')}`);
					if (v.missing.length) it.track.warnings.push(`Missing: ${v.missing.join(', ')}`);
					it.track.title = tags.title ?? it.track.title;
					done.set(it, { out, tags });
				} catch (err) {
					fail(it.track, err);
				}
				update();
			})
		)
	);
	return done;
}

// ---------------------------------------------------------------- downloads

export async function runDownload(
	ctx: Ctx,
	entries: ResolvedEntry[],
	albumPlaylist: boolean
): Promise<void> {
	const { job, settings, update } = ctx;
	const items: (Item | undefined)[] = [];

	await Promise.all(
		entries.map((entry, i) =>
			ctx.slot(async () => {
				const track = job.tracks[i];
				const dir = join(ctx.workDir, entry.videoId);
				try {
					await mkdir(dir, { recursive: true });
					track.status = 'downloading';
					update();
					const dl = await download(entry.videoId, dir, (pct) => {
						track.progress = pct;
						update();
					});
					track.progress = 100;
					track.status = 'waiting';
					items[i] = {
						track,
						audioPath: dl.audioPath,
						source: sourceFromYouTube(entry.videoId, dl.info, i + 1, entry.albumIndex),
						fallbackArt: dl.thumbnailPath ? { source: 'youtube', path: dl.thumbnailPath } : undefined
					};
				} catch (err) {
					fail(track, err);
				}
				update();
			})
		)
	);

	const ok = items.filter((i): i is Item => !!i);
	// An album link is one album. A playlist can mix albums: group by YouTube's album name.
	const groups = new Map<string, Item[]>();
	for (const it of ok) {
		const k = albumPlaylist ? 'album' : normalize(it.source.album ?? '') || it.source.key;
		groups.set(k, [...(groups.get(k) ?? []), it]);
	}

	let n = 0;
	for (const group of groups.values()) {
		const tagged = await tagGroup(ctx, group, ++n, 'youtube', albumPlaylist ? entries.length : undefined);
		await withLibraryLock(async () => {
			let lib;
			try {
				lib = await libraryRoot(settings);
			} catch (err) {
				for (const it of tagged.keys()) fail(it.track, err);
				return;
			}
			for (const [it, { out, tags }] of tagged) {
				const warnings = new Set<string>();
				try {
					const dest = destinationFor(lib.root, tags);
					const placed = await placeUnlocked(out, dest, lib.root, lib.owner, settings.existingFiles, warnings);
					it.track.path = placed.path;
					it.track.status = placed.skipped ? 'skipped' : 'done';
					it.track.warnings.push(...warnings);
				} catch (err) {
					fail(it.track, err);
				}
			}
		});
		update();
	}
}

// ---------------------------------------------------------------- re-tag

export async function runRetag(ctx: Ctx, folderAbs: string): Promise<void> {
	const { job, settings, update } = ctx;
	const { root } = await libraryRoot(settings);
	const files = await audioFilesIn(folderAbs);
	if (!files.length) throw new Error('No .m4a files in that folder.');

	job.tracks = files.map((f) => ({
		key: relative(root, f),
		title: basename(f, extname(f)),
		status: 'queued',
		progress: 0,
		warnings: []
	}));
	update();

	const items: (Item | undefined)[] = [];
	await Promise.all(
		files.map((abs, i) =>
			ctx.slot(async () => {
				const track = job.tracks[i];
				try {
					const probe = await probeFile(abs);
					const coverPath = join(ctx.workDir, `existing-${i}.jpg`);
					await mkdir(ctx.workDir, { recursive: true });
					const hasCover = await extractCover(abs, coverPath);
					items[i] = {
						track,
						audioPath: abs,
						source: sourceFromFile(track.key, abs, probe.tags, probe.durationSec, i + 1),
						fallbackArt: hasCover ? { source: 'existing', path: coverPath } : undefined,
						original: { abs, tags: probe.tags }
					};
				} catch (err) {
					fail(track, err);
				}
			})
		)
	);

	const ok = items.filter((i): i is Item => !!i);
	if (!ok.length) return;
	const tagged = await tagGroup(ctx, ok, 1, 'existing');
	if (!tagged.size) return;

	await withLibraryLock(async () => {
		const lib = await libraryRoot(settings);
		const ready = [...tagged.keys()];
		const backupId = await createBackupUnlocked(
			lib.root,
			relative(lib.root, folderAbs),
			ready.map((it) => it.original!.abs)
		);
		job.backupId = backupId;
		update();

		// Move originals out of the way first so tracks can trade file names without clashing.
		for (const it of ready) await unlink(it.original!.abs);

		const current = new Map<string, string>();
		for (const it of ready) {
			const { out, tags } = tagged.get(it)!;
			const warnings = new Set<string>();
			const oldRel = relative(lib.root, it.original!.abs);
			try {
				const dest = destinationFor(lib.root, tags);
				const placed = await placeUnlocked(out, dest, lib.root, lib.owner, 'keep-both', warnings);
				current.set(oldRel, placed.path);
				it.track.path = placed.path;
				it.track.changes = describeChanges(it.original!.tags, tags, oldRel, placed.path);
				it.track.status = 'done';
				it.track.warnings.push(...warnings);
			} catch (err) {
				fail(it.track, err);
				it.track.warnings.push('The original is in the backup; use Undo to restore it.');
			}
		}
		await recordCurrentPaths(backupId, current);
		await removeEmptyDirs(lib.root, folderAbs);
	});
	update();
}
