import type { DeezerAlbumResult, DeezerTrackResult } from '$lib/types';
import { DEFAULT_UA } from './http';

// Deezer's public API: no key, about 50 requests per 5 s per IP.
const API = 'https://api.deezer.com';
const SPACING_MS = 120;

let queue: Promise<unknown> = Promise.resolve();
let last = 0;

function throttled<T>(fn: () => Promise<T>): Promise<T> {
	const next = queue.then(async () => {
		const wait = last + SPACING_MS - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		last = Date.now();
		return fn();
	});
	queue = next.catch(() => undefined);
	return next;
}

interface DeezerError {
	error?: { type?: string; message?: string; code?: number };
}

/** GET a Deezer endpoint. Retries when over quota; undefined when Deezer has no such item. */
async function dz<T>(path: string): Promise<T | undefined> {
	for (let attempt = 0; attempt < 4; attempt++) {
		const body = await throttled(async () => {
			const res = await fetch(`${API}${path}`, {
				headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
				signal: AbortSignal.timeout(15000)
			});
			if (!res.ok) throw new Error(`Deezer responded ${res.status}`);
			return (await res.json()) as T & DeezerError;
		});
		if (!body.error) return body;
		if (body.error.code === 4) {
			// "Quota limit exceeded": back off and retry.
			await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
			continue;
		}
		if (body.error.code === 800) return undefined; // "no data"
		throw new Error(`Deezer: ${body.error.message ?? 'unknown error'}`);
	}
	throw new Error('Deezer is rate limiting; try again in a minute.');
}

interface RawArtist {
	id: number;
	name: string;
	role?: string;
}

interface RawAlbumRef {
	id: number;
	title: string;
	cover_medium?: string;
	cover_big?: string;
	cover_xl?: string;
}

interface RawTrack {
	id: number;
	title: string;
	duration: number;
	track_position?: number;
	disk_number?: number;
	artist: RawArtist;
	album?: RawAlbumRef;
	contributors?: RawArtist[];
}

interface RawAlbum extends RawAlbumRef {
	artist: RawArtist;
	nb_tracks: number;
	record_type?: string;
	release_date?: string;
	genres?: { data?: { name: string }[] };
}

// Albums without art point at a placeholder with an empty hash: ".../cover//1000x1000-...".
const realCover = (url: string | undefined) => (url && !url.includes('/cover//') ? url : undefined);

export function coverFor(album: { coverBig?: string; coverXl?: string }, size: number): string | undefined {
	return size <= 500 ? album.coverBig : album.coverXl;
}

// ---------------------------------------------------------------- search

export async function searchAlbums(q: string, limit = 12): Promise<DeezerAlbumResult[]> {
	const res = await dz<{ data?: RawAlbum[] }>(`/search/album?q=${encodeURIComponent(q)}&limit=${limit}`);
	return (res?.data ?? []).map((a) => ({
		id: a.id,
		title: a.title,
		artist: a.artist?.name ?? '',
		cover: realCover(a.cover_medium),
		tracks: a.nb_tracks,
		type: a.record_type ?? 'album'
	}));
}

export async function searchTracks(q: string, limit = 12): Promise<DeezerTrackResult[]> {
	const res = await dz<{ data?: RawTrack[] }>(`/search/track?q=${encodeURIComponent(q)}&limit=${limit}`);
	return (res?.data ?? []).map((t) => ({
		id: t.id,
		title: t.title,
		artist: t.artist?.name ?? '',
		album: t.album?.title ?? '',
		albumId: t.album?.id ?? 0,
		cover: realCover(t.album?.cover_medium),
		durationSec: t.duration
	}));
}

// ---------------------------------------------------------------- albums

export interface DeezerAlbumTrack {
	id: number;
	title: string;
	artist: string; // main artist only; full credits come from getTrackCredits
	durationSec: number;
	position: number;
	disc: number;
	index: number; // 1-based across all discs
}

export interface DeezerAlbum {
	id: number;
	title: string;
	artist: string;
	year?: string;
	genre?: string;
	coverBig?: string; // 500×500
	coverXl?: string; // 1000×1000
	type: string;
	tracks: DeezerAlbumTrack[];
	tracksPerDisc: Record<number, number>;
	discCount: number;
}

const albumCache = new Map<number, Promise<DeezerAlbum | undefined>>();

/** Album details plus its full tracklist (two requests, cached). */
export function getAlbum(id: number): Promise<DeezerAlbum | undefined> {
	let p = albumCache.get(id);
	if (!p) {
		p = (async () => {
			const album = await dz<RawAlbum>(`/album/${id}`);
			if (!album) return undefined;
			const list = await dz<{ data?: RawTrack[] }>(`/album/${id}/tracks?limit=500`);
			const tracks = (list?.data ?? [])
				.map((t) => ({
					id: t.id,
					title: t.title,
					artist: t.artist?.name ?? album.artist.name,
					durationSec: t.duration,
					position: t.track_position ?? 0,
					disc: t.disk_number ?? 1
				}))
				.sort((a, b) => a.disc - b.disc || a.position - b.position)
				.map((t, i) => ({ ...t, index: i + 1 }));
			const tracksPerDisc: Record<number, number> = {};
			for (const t of tracks) tracksPerDisc[t.disc] = (tracksPerDisc[t.disc] ?? 0) + 1;
			return {
				id: album.id,
				title: album.title,
				artist: album.artist.name,
				year: album.release_date?.slice(0, 4) || undefined,
				genre: album.genres?.data?.[0]?.name,
				coverBig: realCover(album.cover_big),
				coverXl: realCover(album.cover_xl),
				type: album.record_type ?? 'album',
				tracks,
				tracksPerDisc,
				discCount: Math.max(1, ...tracks.map((t) => t.disc))
			};
		})();
		p.catch(() => albumCache.delete(id));
		albumCache.set(id, p);
		if (albumCache.size > 300) albumCache.delete(albumCache.keys().next().value!);
	}
	return p;
}

const creditCache = new Map<number, Promise<string[]>>();

/** Every credited artist of a track: main artists first (the track's own artist leading), then featured. */
export function getTrackCredits(id: number): Promise<string[]> {
	let p = creditCache.get(id);
	if (!p) {
		p = (async () => {
			const t = await dz<RawTrack>(`/track/${id}`);
			if (!t) return [];
			const contributors = t.contributors ?? [];
			const main = contributors.filter((c) => c.role !== 'Featured').map((c) => c.name);
			const featured = contributors.filter((c) => c.role === 'Featured').map((c) => c.name);
			const names = [t.artist.name, ...main, ...featured];
			return names.filter((n, i) => names.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i);
		})();
		p.catch(() => creditCache.delete(id));
		creditCache.set(id, p);
		if (creditCache.size > 2000) creditCache.delete(creditCache.keys().next().value!);
	}
	return p;
}

/** The album a track belongs to, for "pick this song" in a review. */
export async function albumOfTrack(trackId: number): Promise<number | undefined> {
	const t = await dz<RawTrack>(`/track/${trackId}`);
	return t?.album?.id;
}

export const deezerAlbumUrl = (id: number) => `https://www.deezer.com/album/${id}`;
