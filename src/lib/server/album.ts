import type { AlbumMatch, MetadataSource } from '$lib/types';
import { artistKey, creditTrack, majority, parseArtistField, stripFeat, stripVideoNoise } from './artists';
import { getRelease, searchRecordings, searchReleases, type Release, type ReleaseTrack } from './musicbrainz';
import type { Tags } from './tags';
import { lucene, normalize, sameish } from './text';

/** What we know about a track before matching: from yt-dlp, or from the file's existing tags. */
export interface SourceTrack {
	key: string;
	title: string;
	artists: string[]; // primary first
	album?: string;
	year?: string;
	genre?: string;
	durationSec?: number;
	disc?: number;
	position?: number; // trusted track number, if any
	trackCount?: number;
	seq: number; // 1-based order within the album/folder
	/** A plain YouTube video (no music metadata): title and uploader are all we have. */
	fromVideo?: boolean;
	/** Set by cleanSource: metadata came from a video title, so matching is more lenient. */
	loose?: boolean;
}

export interface ResolvedAlbum {
	match: AlbumMatch;
	release?: Release;
	tags: Map<string, Tags>;
}

const DURATION_TOLERANCE_SEC = 5;
// Music videos often have intros/outros, so video-derived tracks get more slack.
const LOOSE_DURATION_TOLERANCE_SEC = 20;

/**
 * Turns "Artist - Song (Lyrics)" uploaded by "Some Lyrics Channel" into "Song" by "Artist".
 * "Artist - Title" is only split for video-like sources or when the left side is a known
 * artist, so real titles like "Feel So Close - Radio Edit" stay intact.
 */
export function cleanSource(s: SourceTrack): SourceTrack {
	const { text, noisy } = stripVideoNoise(s.title);
	const video = noisy || !!s.fromVideo;
	let title = text;
	let artists = s.artists;

	const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(text);
	if (dash) {
		const left = parseArtistField(dash[1]);
		const known = new Set(artists.map(artistKey));
		const leftKnown = left.some((a) => known.has(artistKey(a)));
		if (video || leftKnown) {
			// The uploader of a video is usually a channel, not an artist: drop it.
			artists = leftKnown ? [...left, ...artists.filter((a) => !left.some((l) => artistKey(l) === artistKey(a)))] : left;
			title = dash[2];
		}
	}
	title = title.replace(/^["'“‘]+|["'”’]+$/g, '').trim() || text;

	// An "album" that is just the video title isn't an album.
	const album =
		s.album && normalize(stripVideoNoise(s.album).text) !== normalize(text) ? s.album : undefined;
	return { ...s, title, artists, album, loose: video };
}

function sameTitle(a: string, b: string): boolean {
	const na = normalize(stripFeat(a).base);
	return na.length > 0 && na === normalize(stripFeat(b).base);
}

function durationOk(s: SourceTrack, lengthMs: number | null | undefined): boolean {
	if (!s.durationSec || !lengthMs) return true;
	const tolerance = s.loose ? LOOSE_DURATION_TOLERANCE_SEC : DURATION_TOLERANCE_SEC;
	return Math.abs(lengthMs / 1000 - s.durationSec) <= tolerance;
}

/** Maps source tracks onto a release's tracklist; each release track is used once. */
function matchTracks(src: SourceTrack[], release: Release): Map<string, ReleaseTrack> {
	const used = new Set<number>();
	const map = new Map<string, ReleaseTrack>();
	for (const s of src) {
		const options = release.tracks.filter(
			(t) => !used.has(t.index) && sameTitle(s.title, t.title) && durationOk(s, t.lengthMs)
		);
		const pick =
			options.find((t) => s.position && t.position === s.position && t.disc === (s.disc ?? 1)) ??
			options.find((t) => t.index === s.seq) ??
			options[0];
		if (pick) {
			used.add(pick.index);
			map.set(s.key, pick);
		}
	}
	return map;
}

function mostCommon(values: (string | undefined)[]): string | undefined {
	return majority(values.filter((v): v is string => !!v));
}

interface Candidate {
	release: Release;
	map: Map<string, ReleaseTrack>;
}

/**
 * Finds the one release whose tracklist fits the whole album, instead of matching songs
 * one by one (which drifts to compilations, singles and deluxe editions).
 */
async function findRelease(
	src: SourceTrack[],
	album: string,
	anchorArtist: string | undefined,
	contact: string
): Promise<{ best?: Candidate; note?: string }> {
	// Word query ignores punctuation, so "Gladiator - Music From…" still finds "Gladiator: Music From…".
	const words = normalize(album).split(' ').filter(Boolean).map(lucene);
	const queries = [
		anchorArtist ? `release:"${lucene(album)}" AND artist:"${lucene(anchorArtist)}"` : '',
		`release:"${lucene(album)}"`,
		words.length ? `release:(${words.join(' AND ')})` : ''
	].filter(Boolean);

	const exact = (t: string) => t.toLowerCase() === album.toLowerCase();
	const ids: string[] = [];
	for (const q of queries) {
		const found = (await searchReleases(q, contact)).filter((r) => sameish(r.title, album));
		found.sort(
			(a, b) =>
				Number(exact(b.title)) - Number(exact(a.title)) ||
				Math.abs((a['track-count'] ?? 0) - src.length) - Math.abs((b['track-count'] ?? 0) - src.length) ||
				Number(b.status === 'Official') - Number(a.status === 'Official') ||
				b.score - a.score
		);
		ids.push(...found.map((r) => r.id));
		if (ids.length) break;
	}

	// Still nothing: ask which releases contain these songs, and try the most common ones.
	if (!ids.length && words.length) {
		const votes = new Map<string, number>();
		for (const s of src.slice(0, 4)) {
			const title = stripFeat(s.title).base;
			if (!title) continue;
			const recordings = await searchRecordings(
				`recording:"${lucene(title)}" AND release:(${words.join(' AND ')})`,
				contact
			);
			for (const rec of recordings) {
				if (!sameTitle(rec.title, title)) continue;
				for (const rel of rec.releases ?? []) {
					// Still has to be this album, not a compilation that contains the song.
					if (sameish(rel.title, album)) votes.set(rel.id, (votes.get(rel.id) ?? 0) + 1);
				}
			}
		}
		ids.push(...[...votes.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id));
	}
	if (!ids.length) return { note: 'No release with this album title on MusicBrainz.' };

	let best: Candidate | undefined;
	for (const id of [...new Set(ids)].slice(0, 6)) {
		const release = await getRelease(id, contact);
		if (!release) continue;
		const map = matchTracks(src, release);
		const better =
			!best ||
			map.size > best.map.size ||
			(map.size === best.map.size &&
				Math.abs(release.tracks.length - src.length) < Math.abs(best.release.tracks.length - src.length));
		if (better) best = { release, map };
		if (map.size === src.length && release.tracks.length === src.length) break; // perfect fit
	}
	if (!best) return { note: 'MusicBrainz lookups failed.' };

	// The whole-tracklist check is what keeps compilations and "best of" releases out.
	const needed = src.length >= 3 ? Math.ceil(src.length * 0.8) : src.length;
	if (best.map.size < needed) {
		return { note: `Best MusicBrainz release matched only ${best.map.size} of ${src.length} tracks.` };
	}
	return { best };
}

const RELEASE_TYPE_RANK: Record<string, number> = { Album: 3, EP: 2, Single: 1 };

/** Compares rank tuples element by element; positive when `a` is better. */
function compareRanks(a: number[], b: number[]): number {
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return 0;
}

/**
 * Song-by-song fallback when no album matched: search the recording by title + artist,
 * then pick its best release (official studio album > EP > single, oldest first).
 */
async function findRecording(
	s: SourceTrack,
	contact: string
): Promise<{ release: Release; track: ReleaseTrack } | undefined> {
	const artist = s.artists[0];
	const title = stripFeat(s.title).base;
	if (!artist || !title) return undefined;

	const recordings = await searchRecordings(
		`recording:"${lucene(title)}" AND artist:"${lucene(artist)}"`,
		contact
	);
	type Pick = { recordingId: string; releaseId: string; rank: number[] };
	let best: Pick | undefined;
	for (const rec of recordings) {
		if (rec.score < 80 || !sameTitle(rec.title, title) || !durationOk(s, rec.length)) continue;
		const credited = (rec['artist-credit'] ?? []).map((c) => artistKey(c.name));
		if (!credited.includes(artistKey(artist))) continue;

		for (const rel of rec.releases ?? []) {
			// When the song's album is known, only that album counts, never another
			// release that happens to contain the song (a compilation, a "best of"…).
			if (s.album && !sameish(rel.title, s.album)) continue;
			const rg = rel['release-group'];
			const secondary = rg?.['secondary-types'] ?? [];
			// Higher is better, compared element by element.
			const rank = [
				rel.status === 'Official' ? 1 : 0,
				secondary.some((t) => ['Compilation', 'Live', 'DJ-mix', 'Remix'].includes(t)) ? 0 : 1,
				RELEASE_TYPE_RANK[rg?.['primary-type'] ?? ''] ?? 0,
				-Number((rel.date ?? '9999').slice(0, 4)) // oldest first
			];
			if (!best || compareRanks(rank, best.rank) > 0) best = { recordingId: rec.id, releaseId: rel.id, rank };
		}
	}
	if (!best) return undefined;

	const release = await getRelease(best.releaseId, contact);
	const track =
		release?.tracks.find((t) => t.recordingId === best.recordingId) ??
		release?.tracks.find((t) => sameTitle(t.title, title));
	return release && track ? { release, track } : undefined;
}

function tagsFromRelease(release: Release, rt: ReleaseTrack, s: SourceTrack, albumArtist: string): Tags {
	const credited = creditTrack(rt.credits.length ? rt.credits : s.artists, rt.title);
	return {
		title: credited.title,
		artist: credited.artist,
		albumArtist,
		album: release.title,
		trackNumber: rt.position,
		trackCount: release.tracksPerDisc[rt.disc],
		discNumber: rt.disc,
		discCount: release.discCount,
		year: release.year,
		genre: release.genre ?? s.genre
	};
}

/** Album artist = most frequent primary artist over the release's full tracklist. */
const releaseAlbumArtist = (release: Release, fallback?: string) =>
	majority(release.tracks.map((t) => t.credits[0])) ?? fallback ?? 'Unknown Artist';

/** Decides album, album artist, year and per-track tags for one album's worth of tracks. */
export async function resolveAlbum(
	rawSrc: SourceTrack[],
	opts: { fallbackSource: MetadataSource; contact: string; knownTrackCount?: number }
): Promise<ResolvedAlbum> {
	const src = rawSrc.map(cleanSource);
	const albumTitle = mostCommon(src.map((s) => s.album));
	const anchor = majority(src.map((s) => s.artists[0]));

	let candidate: Candidate | undefined;
	let note: string | undefined;
	if (!opts.contact) note = 'MusicBrainz skipped: add a contact email in Settings.';
	else if (!albumTitle) note = 'No album name to search for.';
	else {
		try {
			const r = await findRelease(src, albumTitle, anchor, opts.contact);
			candidate = r.best;
			note = r.note;
		} catch (err) {
			note = `MusicBrainz unavailable: ${(err as Error).message}`;
		}
	}

	const tags = new Map<string, Tags>();

	if (candidate) {
		const { release, map } = candidate;
		// Counted over the full tracklist so partial downloads get the same album artist.
		const albumArtist = releaseAlbumArtist(release, anchor);
		for (const s of src) {
			const rt = map.get(s.key);
			if (rt) tags.set(s.key, tagsFromRelease(release, rt, s, albumArtist));
			else {
				const credited = creditTrack(s.artists, s.title);
				tags.set(s.key, {
					title: credited.title,
					artist: credited.artist,
					albumArtist,
					album: release.title,
					trackNumber: s.position,
					trackCount: release.tracksPerDisc[s.disc ?? 1],
					discNumber: s.disc ?? 1,
					discCount: release.discCount,
					year: release.year,
					genre: release.genre ?? s.genre
				});
			}
		}
		return {
			release,
			tags,
			match: {
				album: release.title,
				albumArtist,
				year: release.year,
				source: 'musicbrainz',
				releaseId: release.id,
				matched: map.size,
				total: src.length,
				note: map.size < src.length ? `${src.length - map.size} track(s) kept their own title/artist.` : undefined
			}
		};
	}

	// No album fit. A single song may still be found on its own; an album never is, because
	// matching its songs one by one scatters them across compilations and "best of" releases.
	const perTrack = new Map<string, { release: Release; track: ReleaseTrack }>();
	if (opts.contact && src.length === 1) {
		for (const s of src) {
			try {
				const hit = await findRecording(s, opts.contact);
				if (hit) perTrack.set(s.key, hit);
			} catch {
				// network/rate-limit trouble: this track keeps its source metadata
			}
		}
	}

	if (perTrack.size) {
		const releases = new Map<string, Release>();
		for (const { release } of perTrack.values()) releases.set(release.id, release);
		for (const [key, { release, track }] of perTrack) {
			const s = src.find((x) => x.key === key)!;
			tags.set(key, tagsFromRelease(release, track, s, releaseAlbumArtist(release, s.artists[0])));
		}
		const rest = src.filter((s) => !perTrack.has(s.key));
		if (rest.length) fillFromSource(rest, tags, opts.knownTrackCount);

		const [first] = releases.values();
		const single = releases.size === 1;
		const firstTags = tags.get([...perTrack.keys()][0])!;
		return {
			release: single ? first : undefined,
			tags,
			match: {
				album: firstTags.album ?? first.title,
				albumArtist: firstTags.albumArtist ?? 'Unknown Artist',
				year: firstTags.year,
				source: 'musicbrainz',
				releaseId: first.id,
				matched: perTrack.size,
				total: src.length,
				note: [
					`${note ?? 'Album not found.'} Matched song by song instead`,
					single ? '.' : `, across ${releases.size} releases.`,
					rest.length ? ` ${rest.length} track(s) kept their own tags.` : ''
				].join('')
			}
		};
	}

	if (src.length > 1 && opts.contact) {
		note = `${note ?? ''} Kept the album's own tags so its songs stay together.`.trim();
	}

	// Fallback: the source's own metadata, but one album title/artist/year for every track.
	const { album, albumArtist, year } = fillFromSource(src, tags, opts.knownTrackCount);
	return {
		tags,
		match: {
			album,
			albumArtist,
			year,
			source: opts.fallbackSource,
			matched: 0,
			total: src.length,
			note
		}
	};
}

/** Tags from the (cleaned) source metadata, sharing one album/album artist/year. */
function fillFromSource(src: SourceTrack[], tags: Map<string, Tags>, knownTrackCount?: number) {
	const albumArtist = majority(src.map((s) => s.artists[0])) ?? 'Unknown Artist';
	const album = mostCommon(src.map((s) => s.album)) ?? (src.length === 1 ? stripFeat(src[0].title).base : 'Unknown Album');
	const year = mostCommon(src.map((s) => s.year));
	const discCount = Math.max(1, ...src.map((s) => s.disc ?? 1));
	for (const s of src) {
		const credited = creditTrack(s.artists, s.title);
		tags.set(s.key, {
			title: credited.title,
			artist: credited.artist,
			albumArtist,
			album,
			trackNumber: s.position,
			trackCount: knownTrackCount ?? s.trackCount,
			discNumber: s.disc ?? (discCount > 1 ? 1 : undefined),
			discCount: discCount > 1 ? discCount : undefined,
			year,
			genre: s.genre
		});
	}
	return { album, albumArtist, year };
}
