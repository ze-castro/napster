import type { AlbumTagsInput, Proposal, TrackTagsInput } from '$lib/types';
import { artistKey, creditParts, majority, parseArtistField, stripFeat, stripVideoNoise } from './artists';
import {
	coverFor,
	deezerAlbumUrl,
	getAlbum,
	getTrackCredits,
	searchAlbums,
	searchTracks,
	type DeezerAlbum,
	type DeezerAlbumTrack
} from './deezer';
import { normalize, sameish } from './text';

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

export type MatchResult =
	| { kind: 'matched'; proposal: Proposal }
	| { kind: 'close'; proposal: Proposal; note: string }
	| { kind: 'none'; note: string };

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
	const album = s.album && normalize(stripVideoNoise(s.album).text) !== normalize(text) ? s.album : undefined;
	return { ...s, title, artists, album, loose: video };
}

/** The editable form of a (cleaned) source track: one artist, featured artists, bare title. */
export function sourceToInput(s: SourceTrack): TrackTagsInput {
	const parts = creditParts(s.artists, s.title);
	return {
		key: s.key,
		title: parts.title,
		artist: parts.artist ?? '',
		featured: parts.featured,
		trackNumber: s.position,
		discNumber: s.disc
	};
}

/** Album-level fields from the sources: one album name, album artist and year for every song. */
export function sourceAlbum(src: SourceTrack[]): AlbumTagsInput {
	const album = mostCommon(src.map((s) => s.album)) ?? (src.length === 1 ? stripFeat(src[0].title).base : '');
	return {
		album,
		albumArtist: majority(src.map((s) => s.artists[0])) ?? '',
		year: mostCommon(src.map((s) => s.year)),
		genre: mostCommon(src.map((s) => s.genre))
	};
}

function mostCommon(values: (string | undefined)[]): string | undefined {
	return majority(values.filter((v): v is string => !!v));
}

function sameTitle(a: string, b: string): boolean {
	const na = normalize(stripFeat(a).base);
	return na.length > 0 && na === normalize(stripFeat(b).base);
}

function durationOk(s: SourceTrack, sec: number | undefined): boolean {
	if (!s.durationSec || !sec) return true;
	const tolerance = s.loose ? LOOSE_DURATION_TOLERANCE_SEC : DURATION_TOLERANCE_SEC;
	return Math.abs(sec - s.durationSec) <= tolerance;
}

/** Maps our songs onto an album's tracklist; each album track is used once. */
function matchTracks(src: SourceTrack[], album: DeezerAlbum): Map<string, DeezerAlbumTrack> {
	const used = new Set<number>();
	const map = new Map<string, DeezerAlbumTrack>();
	for (const s of src) {
		const options = album.tracks.filter(
			(t) => !used.has(t.index) && sameTitle(s.title, t.title) && durationOk(s, t.durationSec)
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

/**
 * Deezer's tags for our songs. Album artist = most frequent main artist over the album's full
 * tracklist (ties: first in order), so partial downloads get the same album artist.
 * Songs not found on the album keep their own title/artist, but share the album fields.
 */
export async function buildProposal(
	src: SourceTrack[],
	album: DeezerAlbum,
	map: Map<string, DeezerAlbumTrack>,
	artSize: number
): Promise<Proposal> {
	const tracks: TrackTagsInput[] = [];
	for (const s of src) {
		const t = map.get(s.key);
		if (!t) {
			tracks.push(sourceToInput(s));
			continue;
		}
		const credits = await getTrackCredits(t.id).catch(() => [] as string[]);
		const parts = creditParts(credits.length ? credits : [t.artist], t.title);
		tracks.push({
			key: s.key,
			title: parts.title,
			artist: parts.artist ?? t.artist,
			featured: parts.featured,
			trackNumber: t.position || undefined,
			discNumber: t.disc
		});
	}
	return {
		deezerAlbumId: album.id,
		deezerUrl: deezerAlbumUrl(album.id),
		coverUrl: coverFor(album, artSize),
		album: {
			album: album.title,
			albumArtist: majority(album.tracks.map((t) => t.artist)) ?? album.artist,
			year: album.year,
			genre: album.genre,
			tracksPerDisc: album.tracksPerDisc,
			discCount: album.discCount
		},
		tracks,
		matched: map.size,
		total: src.length
	};
}

/** Proposal for a specific Deezer album the user picked. */
export async function proposalForAlbum(src: SourceTrack[], albumId: number, artSize: number): Promise<Proposal | undefined> {
	const album = await getAlbum(albumId);
	if (!album) return undefined;
	return buildProposal(src, album, matchTracks(src, album), artSize);
}

/** Proposal for a specific Deezer song the user picked (single-song reviews). */
export async function proposalForTrack(
	src: SourceTrack,
	trackId: number,
	albumId: number,
	artSize: number
): Promise<Proposal | undefined> {
	const album = await getAlbum(albumId);
	const track = album?.tracks.find((t) => t.id === trackId);
	if (!album || !track) return undefined;
	return buildProposal([src], album, new Map([[src.key, track]]), artSize);
}

// ---------------------------------------------------------------- automatic matching

/** Albums: the one Deezer album whose tracklist fits. Single songs: title + artist (+ album when known). */
export async function matchGroup(rawSrc: SourceTrack[], artSize: number): Promise<MatchResult> {
	const src = rawSrc.map(cleanSource);
	return src.length === 1 ? matchSong(src[0], artSize) : matchAlbum(src, artSize);
}

async function matchAlbum(src: SourceTrack[], artSize: number): Promise<MatchResult> {
	const title = mostCommon(src.map((s) => s.album));
	const artist = majority(src.map((s) => s.artists[0]));
	if (!title) return { kind: 'none', note: 'No album name to search Deezer with.' };

	const queries = [
		artist ? `album:"${title}" artist:"${artist}"` : '',
		`album:"${title}"`,
		[title, artist].filter(Boolean).join(' ')
	].filter(Boolean);

	const ids: number[] = [];
	for (const q of queries) {
		const found = (await searchAlbums(q)).filter((a) => sameish(a.title, title));
		const exact = (t: string) => t.toLowerCase() === title.toLowerCase();
		found.sort(
			(a, b) =>
				Number(exact(b.title)) - Number(exact(a.title)) ||
				Math.abs(a.tracks - src.length) - Math.abs(b.tracks - src.length)
		);
		for (const a of found) if (!ids.includes(a.id)) ids.push(a.id);
		if (ids.length >= 3) break;
	}
	if (!ids.length) return { kind: 'none', note: 'No album with this name on Deezer.' };

	let best: { album: DeezerAlbum; map: Map<string, DeezerAlbumTrack> } | undefined;
	for (const id of ids.slice(0, 6)) {
		const album = await getAlbum(id);
		if (!album) continue;
		const map = matchTracks(src, album);
		const better =
			!best ||
			map.size > best.map.size ||
			(map.size === best.map.size &&
				Math.abs(album.tracks.length - src.length) < Math.abs(best.album.tracks.length - src.length));
		if (better) best = { album, map };
		if (map.size === src.length && album.tracks.length === src.length) break; // perfect fit
	}
	if (!best) return { kind: 'none', note: 'Deezer lookups failed.' };

	const proposal = await buildProposal(src, best.album, best.map, artSize);
	// The whole-tracklist check keeps compilations and "best of" albums out.
	const needed = src.length >= 3 ? Math.ceil(src.length * 0.8) : src.length;
	if (best.map.size >= needed) return { kind: 'matched', proposal };
	if (best.map.size === 0) return { kind: 'none', note: 'No Deezer album with this name contains these songs.' };
	return {
		kind: 'close',
		proposal,
		note: `Deezer's closest album fits ${best.map.size} of ${src.length} songs.`
	};
}

async function matchSong(s: SourceTrack, artSize: number): Promise<MatchResult> {
	const artist = s.artists[0];
	const title = stripFeat(s.title).base;
	if (!title) return { kind: 'none', note: 'The song has no title to search with.' };

	const results = await searchTracks(artist ? `artist:"${artist}" track:"${title}"` : `track:"${title}"`);
	const fallback = results.length ? results : await searchTracks([title, artist].filter(Boolean).join(' '));

	const titled = fallback.filter((t) => sameTitle(t.title, title));
	const good = titled.filter(
		(t) => (!artist || artistKey(t.artist) === artistKey(artist)) && durationOk(s, t.durationSec)
	);
	// When the song's album is known, only that album counts, not a compilation that has the song.
	const onAlbum = s.album ? good.filter((t) => sameish(t.album, s.album)) : good;

	const pick = onAlbum[0];
	if (pick) {
		const proposal = await proposalForTrack(s, pick.id, pick.albumId, artSize);
		if (proposal) return { kind: 'matched', proposal };
	}

	const near = good[0] ?? titled[0];
	if (near) {
		const proposal = await proposalForTrack(s, near.id, near.albumId, artSize);
		if (proposal) {
			const why =
				good[0] && s.album
					? `Found on a different album: “${near.album}”.`
					: `Closest result is “${near.title}” by ${near.artist}.`;
			return { kind: 'close', proposal, note: why };
		}
	}
	return { kind: 'none', note: 'Not found on Deezer.' };
}
