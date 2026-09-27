import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { Settings } from '$lib/settings';
import type { AlbumMatch, ArtSource, JobState, ResolveInput, TrackState } from '$lib/types';
import { parseArtistField, stripFeat } from './artists';
import { localCover, prepareCover, remoteCover, type ArtCandidate } from './artwork';
import { createBackupUnlocked, recordCurrentPaths } from './backups';
import {
	audioFilesIn,
	destinationFor,
	libraryRoot,
	placeUnlocked,
	removeEmptyDirs,
	withLibraryLock
} from './library';
import {
	cleanSource,
	matchGroup,
	sourceAlbum,
	sourceToInput,
	type MatchResult,
	type SourceTrack
} from './match';
import {
	addReview,
	currentCoverPath,
	ensurePendingDir,
	missingFiles,
	pathsInReviews,
	relinkPaths,
	type Review
} from './reviews';
import { recordMoves } from './moves';
import { toTags, type Tags } from './tags';
import { extractCover, probeFile, verify, writeTags } from './tagging';
import { normalize } from './text';
import { download, type ResolvedEntry, type YtInfo } from './ytdlp';

export type Slot = <T>(fn: () => Promise<T>) => Promise<T>;

export interface Ctx {
	job: JobState;
	settings: Settings;
	workDir: string;
	update: () => void;
	slot: Slot;
}

export interface Item {
	track: TrackState;
	source: SourceTrack;
	audioPath: string;
	fallbackArt?: { source: ArtSource; path: string };
	/** Re-tag only: the file in the library and its tags before we touched it. */
	original?: { abs: string; tags: Record<string, string> };
}

type Mode = 'download' | 'retag';

function fail(track: TrackState, err: unknown) {
	track.status = 'failed';
	track.error = err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- source data

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

function sourceFromFile(
	key: string,
	abs: string,
	tags: Record<string, string>,
	durationSec: number | undefined,
	seq: number
): SourceTrack {
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

/** Every track of a job that isn't settled keeps the job open. */
export function settle(job: JobState) {
	if (job.tracks.some((t) => t.status === 'needs-input')) job.status = 'needs-input';
	else if (job.tracks.length && job.tracks.every((t) => t.status === 'failed')) job.status = 'failed';
	else job.status = 'done';
}

// ---------------------------------------------------------------- write + place

/**
 * Cover → write + verify every song → put them in the library.
 * Used for automatic Deezer matches and for reviews the user resolved.
 * Returns how many songs made it.
 */
export async function finishGroup(
	ctx: Ctx,
	items: Item[],
	tags: Map<string, Tags>,
	match: AlbumMatch,
	covers: ArtCandidate[],
	mode: Mode
): Promise<number> {
	const { job, settings, update } = ctx;
	const dir = join(ctx.workDir, `album-${randomUUID().slice(0, 8)}`);
	await mkdir(dir, { recursive: true });

	for (const it of items) it.track.status = 'tagging';
	update();

	const cover = join(dir, 'cover.jpg');
	match.artSource = await prepareCover(covers, cover, settings.artSize);
	if (!match.artSource) {
		for (const it of items) fail(it.track, 'Could not get a usable album cover.');
		update();
		return 0;
	}

	const written = new Map<Item, { out: string; tags: Tags }>();
	await Promise.all(
		items.map((it, i) =>
			ctx.slot(async () => {
				try {
					const t = tags.get(it.source.key);
					if (!t) throw new Error('No tags for this song.');
					const out = join(dir, `${i}.m4a`);
					await writeTags(it.audioPath, cover, t, out);
					let v = await verify(out, t);
					if (!v.artOk || v.mismatched.length) {
						await writeTags(it.audioPath, cover, t, out);
						v = await verify(out, t);
					}
					if (!v.artOk) throw new Error('Album art did not verify after writing.');
					if (v.mismatched.length) it.track.warnings.push(`Tags did not verify: ${v.mismatched.join(', ')}`);
					if (v.missing.length) it.track.warnings.push(`Missing: ${v.missing.join(', ')}`);
					it.track.title = t.title ?? it.track.title;
					written.set(it, { out, tags: t });
				} catch (err) {
					fail(it.track, err);
				}
				update();
			})
		)
	);
	if (!written.size) return 0;

	job.albums.push(match);
	const placed = mode === 'download' ? await placeDownloads(ctx, written) : await replaceInLibrary(ctx, written);
	update();
	return placed;
}

async function placeDownloads(ctx: Ctx, written: Map<Item, { out: string; tags: Tags }>): Promise<number> {
	let placed = 0;
	await withLibraryLock(async () => {
		let lib;
		try {
			lib = await libraryRoot(ctx.settings);
		} catch (err) {
			for (const it of written.keys()) fail(it.track, err);
			return;
		}
		for (const [it, { out, tags }] of written) {
			const warnings = new Set<string>();
			try {
				const result = await placeUnlocked(
					out,
					destinationFor(lib.root, tags),
					lib.root,
					lib.owner,
					ctx.settings.existingFiles,
					warnings
				);
				it.track.path = result.path;
				it.track.status = result.skipped ? 'skipped' : 'done';
				it.track.warnings.push(...warnings);
				placed++;
			} catch (err) {
				fail(it.track, err);
			}
		}
	});
	return placed;
}

/** Re-tag: back up the originals (hard links), then swap in the newly tagged files. */
async function replaceInLibrary(ctx: Ctx, written: Map<Item, { out: string; tags: Tags }>): Promise<number> {
	const { job } = ctx;
	let placed = 0;
	await withLibraryLock(async () => {
		const lib = await libraryRoot(ctx.settings);
		const ready = [...written.keys()];
		for (const it of ready) {
			if (!(await stat(it.original!.abs).catch(() => undefined))) {
				throw new Error(`${relative(lib.root, it.original!.abs)} changed since; re-tag the folder again.`);
			}
		}
		const backupId = await createBackupUnlocked(
			lib.root,
			job.folder ?? relative(lib.root, dirname(ready[0].original!.abs)),
			ready.map((it) => it.original!.abs)
		);
		job.backupIds.push(backupId);
		ctx.update();

		// Move originals out of the way first so tracks can trade file names without clashing.
		for (const it of ready) await unlink(it.original!.abs);

		const current = new Map<string, string>();
		const oldDirs = new Set<string>();
		for (const it of ready) {
			const { out, tags } = written.get(it)!;
			const warnings = new Set<string>();
			const oldRel = relative(lib.root, it.original!.abs);
			oldDirs.add(dirname(it.original!.abs));
			try {
				const result = await placeUnlocked(out, destinationFor(lib.root, tags), lib.root, lib.owner, 'keep-both', warnings);
				current.set(oldRel, result.path);
				it.track.path = result.path;
				it.track.changes = describeChanges(it.original!.tags, tags, oldRel, result.path);
				it.track.status = 'done';
				it.track.warnings.push(...warnings);
				placed++;
			} catch (err) {
				fail(it.track, err);
				it.track.warnings.push('The original is in the backup; use Undo to restore it.');
			}
		}
		await recordCurrentPaths(backupId, current);
		for (const d of oldDirs) await removeEmptyDirs(lib.root, d);

		// Other open reviews waiting on these files follow them to their new place.
		const moves = new Map([...current].map(([from, to]) => [join(lib.root, from), join(lib.root, to)]));
		await recordMoves(moves);
		await relinkPaths(moves);
	});
	return placed;
}

// ---------------------------------------------------------------- matching or review

/** Deezer match → finished; otherwise the group waits for the user in a review. */
async function processGroup(ctx: Ctx, items: Item[], mode: Mode, edit = false): Promise<void> {
	for (const it of items) it.track.status = 'tagging';
	ctx.update();

	let result: MatchResult;
	if (edit) result = { kind: 'none', note: '' };
	else {
		try {
			result = await matchGroup(
				items.map((i) => i.source),
				ctx.settings.artSize
			);
		} catch (err) {
			result = { kind: 'none', note: `Deezer unavailable: ${(err as Error).message}` };
		}
	}

	if (result.kind === 'matched') {
		const { proposal: p } = result;
		const tags = new Map(p.tracks.map((t) => [t.key, toTags(p.album, t)]));
		const workDir = join(ctx.workDir, 'covers');
		await mkdir(workDir, { recursive: true });
		await finishGroup(
			ctx,
			items,
			tags,
			{
				album: p.album.album,
				albumArtist: p.album.albumArtist,
				year: p.album.year,
				source: 'deezer',
				deezerAlbumId: p.deezerAlbumId,
				matched: p.matched,
				total: p.total,
				note: p.matched < p.total ? `${p.total - p.matched} song(s) kept their own title/artist.` : undefined
			},
			[
				remoteCover('deezer', workDir, p.coverUrl),
				// Deezer has no cover: the YouTube thumbnail or the existing cover, cropped square.
				...items.flatMap((i) => (i.fallbackArt ? [localCover(i.fallbackArt.source, i.fallbackArt.path)] : []))
			],
			mode
		);
		return;
	}
	await createReview(ctx, items, result, mode, edit);
}

/** Parks a group for the user. Downloaded audio moves to data/pending so it survives restarts. */
async function createReview(ctx: Ctx, items: Item[], result: MatchResult, mode: Mode, edit: boolean) {
	const id = randomUUID();
	const dir = await ensurePendingDir(id);
	const sources = items.map((i) => cleanSource(i.source));
	const current = sourceAlbum(sources);

	const files: Review['files'] = [];
	for (const [i, it] of items.entries()) {
		let path = it.audioPath;
		if (mode === 'download') {
			// Temp folder → data folder can be different filesystems: copy, then delete.
			path = join(dir, `${i}.m4a`);
			await copyFile(it.audioPath, path);
			await unlink(it.audioPath).catch(() => undefined);
		}
		let art: Review['files'][number]['art'];
		if (it.fallbackArt) {
			const artPath = join(dir, `${i}-art.jpg`);
			await copyFile(it.fallbackArt.path, artPath);
			art = { source: it.fallbackArt.source, path: artPath };
		}
		files.push({ key: it.source.key, path, art, originalTags: it.original?.tags });
	}

	const first = sources[0];
	const single = sources.length === 1;
	const review: Review = {
		id,
		jobId: ctx.job.id,
		kind: edit ? 'edit' : mode,
		title:
			ctx.job.folder && (mode === 'retag' || edit) && !single
				? ctx.job.folder
				: single
					? `${first.artists[0] ? `${first.artists[0]} – ` : ''}${stripFeat(first.title).base}`
					: current.album || ctx.job.title,
		reason: edit ? 'edit' : result.kind === 'close' ? 'close-match' : 'not-found',
		songs: files.length,
		note: result.kind === 'none' ? result.note || undefined : result.kind === 'close' ? result.note : undefined,
		createdAt: Date.now(),
		current: {
			...current,
			tracks: sources.map((s, i) => ({
				...sourceToInput(s),
				file: basename(items[i].original?.abs ?? items[i].track.title),
				durationSec: s.durationSec
			}))
		},
		candidate: result.kind === 'close' ? result.proposal : undefined,
		currentCover: files.find((f) => f.art)?.art?.source === 'youtube' ? 'youtube' : files.some((f) => f.art) ? 'existing' : undefined,
		query: single
			? [first.artists[0], stripFeat(first.title).base].filter(Boolean).join(' ')
			: [current.albumArtist, current.album].filter(Boolean).join(' '),
		sources,
		files,
		folder: ctx.job.folder
	};
	await addReview(review);

	for (const it of items) {
		it.track.status = 'needs-input';
		it.track.reviewId = id;
	}
	ctx.update();
}

// ---------------------------------------------------------------- downloads

export async function runDownload(ctx: Ctx, entries: ResolvedEntry[], albumPlaylist: boolean): Promise<void> {
	const { job, update } = ctx;
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
	for (const group of groups.values()) await processGroup(ctx, group, 'download');
}

// ---------------------------------------------------------------- re-tag and edit

export type RetagMode = 'auto' | 'songs';

/**
 * A folder is an album when every song carries the same album tag and no two songs share a
 * track number. Playlists usually fail this: mixed or missing album tags, or every song
 * numbered "1" because each came from a different single.
 */
function looksLikeAlbum(items: Item[]): boolean {
	if (items.length < 2) return true;
	const albums = new Set(items.map((i) => (i.original?.tags.album ?? '').trim().toLowerCase()));
	if (albums.size !== 1 || albums.has('')) return false;
	const numbers = items.filter((i) => i.source.position).map((i) => `${i.source.disc ?? 1}-${i.source.position}`);
	return new Set(numbers).size === numbers.length;
}

/** Re-tags a folder with Deezer, or (edit) goes straight to the tag editor. */
export async function runRetag(ctx: Ctx, folderAbs: string, mode: RetagMode = 'auto', edit = false): Promise<void> {
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
	await mkdir(ctx.workDir, { recursive: true });
	await Promise.all(
		files.map((abs, i) =>
			ctx.slot(async () => {
				const track = job.tracks[i];
				try {
					const probe = await probeFile(abs);
					const coverPath = join(ctx.workDir, `existing-${i}.jpg`);
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

	// A song already waiting in a review is left alone: a second review for the same file
	// would point at a stale path as soon as the first one is saved and moves the file.
	const waiting = await pathsInReviews();
	const ok: Item[] = [];
	for (const it of items) {
		if (!it) continue;
		if (waiting.has(it.original!.abs)) {
			it.track.status = 'skipped';
			it.track.warnings.push('Already waiting under Needs input; finish that review first.');
		} else ok.push(it);
	}
	update();
	if (!ok.length) return;

	let groups: Item[][] = [ok];
	if (mode === 'songs' || !looksLikeAlbum(ok)) {
		// Playlist folder: every song is its own release. An album tag shared by the whole folder
		// (or the folder-name fallback) names the playlist, not the song, so it's dropped along
		// with the track number. Album tags that differ per song are real and kept.
		const counts = new Map<string, number>();
		for (const it of ok) {
			const a = (it.original?.tags.album ?? '').trim().toLowerCase();
			counts.set(a, (counts.get(a) ?? 0) + 1);
		}
		for (const it of ok) {
			const a = (it.original?.tags.album ?? '').trim().toLowerCase();
			if (!a || (counts.get(a) ?? 0) > 1) {
				it.source.album = undefined;
				it.source.position = undefined;
				it.source.trackCount = undefined;
				it.source.disc = undefined;
			}
		}
		groups = ok.map((it) => [it]);
		job.warnings = [
			mode === 'songs'
				? 'Handled as separate songs.'
				: 'This folder looks like a playlist (mixed or missing album tags or track numbers), so each song was handled on its own.'
		];
		update();
	}

	for (const group of groups) await processGroup(ctx, group, 'retag', edit);
}

// ---------------------------------------------------------------- resolving a review

/** Applies the user's tags and cover to a review's songs. Throws (keeping the review) when nothing could be saved. */
export async function applyReview(
	ctx: Ctx,
	review: Review,
	input: ResolveInput,
	upload?: Buffer
): Promise<void> {
	const missing = await missingFiles(review);
	if (missing.length === review.files.length) {
		throw new Error(
			'These files were moved or deleted after this review was created, so there is nothing to save. Use “Leave unchanged” to close it.'
		);
	}
	if (missing.length) {
		throw new Error(
			`${missing.join(', ')} ${missing.length === 1 ? 'was' : 'were'} moved or deleted after this review was created. Use “Leave unchanged” and re-tag the folder again.`
		);
	}

	const byKey = new Map(input.tracks.map((t) => [t.key, t]));
	const items: Item[] = review.files.map((f) => {
		const track =
			ctx.job.tracks.find((t) => t.key === f.key) ??
			({ key: f.key, title: f.key, status: 'needs-input', progress: 100, warnings: [] } satisfies TrackState);
		if (!ctx.job.tracks.includes(track)) ctx.job.tracks.push(track);
		track.error = undefined;
		return {
			track,
			source: review.sources.find((s) => s.key === f.key)!,
			audioPath: f.path,
			fallbackArt: f.art,
			original: review.kind === 'download' ? undefined : { abs: f.path, tags: f.originalTags ?? {} }
		};
	});

	const tags = new Map<string, Tags>();
	for (const it of items) {
		const t = byKey.get(it.source.key);
		if (!t) throw new Error('Every song needs its tags.');
		tags.set(it.source.key, toTags(input.album, t));
	}

	await mkdir(ctx.workDir, { recursive: true });
	const covers: ArtCandidate[] = [];
	const c = input.cover;
	if (c.type === 'deezer') covers.push(remoteCover('deezer', ctx.workDir, c.url));
	else if (c.type === 'url') covers.push(remoteCover('url', ctx.workDir, c.url));
	else if (c.type === 'upload') {
		if (!upload?.length) throw new Error('Choose an image to upload.');
		const path = join(ctx.workDir, 'upload.src');
		await writeFile(path, upload);
		covers.push(localCover('upload', path));
	} else {
		const path = await currentCoverPath(review);
		const source = review.files.find((f) => f.art)?.art?.source ?? 'existing';
		if (path) covers.push(localCover(source, path));
	}

	const placed = await finishGroup(
		ctx,
		items,
		tags,
		{
			album: input.album.album,
			albumArtist: input.album.albumArtist,
			year: input.album.year,
			source: input.deezerAlbumId ? 'deezer' : 'manual',
			deezerAlbumId: input.deezerAlbumId,
			matched: items.length,
			total: items.length
		},
		covers,
		review.kind === 'download' ? 'download' : 'retag'
	);

	if (!placed) {
		// Nothing was saved: put the songs back in the review so the user can try again.
		const message = items.find((i) => i.track.error)?.track.error ?? 'Nothing could be saved.';
		for (const it of items) {
			it.track.status = 'needs-input';
			it.track.error = undefined;
		}
		ctx.update();
		throw new Error(message);
	}
	for (const it of items) it.track.reviewId = undefined;
}

/** Downloads are deleted; re-tags and edits leave the files untouched. */
export function discardReviewTracks(job: JobState, review: Review) {
	for (const t of job.tracks) {
		if (t.reviewId !== review.id) continue;
		t.reviewId = undefined;
		if (review.kind === 'download') {
			t.status = 'failed';
			t.error = 'Discarded.';
		} else {
			t.status = 'skipped';
			t.warnings.push('Skipped; the file was not changed.');
		}
	}
}

