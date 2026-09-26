import { getJson } from './http';

const API = 'https://musicbrainz.org/ws/2';

interface ArtistCredit {
	name: string;
	joinphrase?: string;
}

export interface SearchRelease {
	id: string;
	score: number;
	title: string;
	status?: string;
	date?: string;
	'track-count'?: number;
}

export interface SearchRecording {
	id: string;
	score: number;
	title: string;
	length?: number | null;
	'artist-credit'?: ArtistCredit[];
	releases?: {
		id: string;
		title: string;
		status?: string;
		date?: string;
		'release-group'?: { 'primary-type'?: string; 'secondary-types'?: string[] };
	}[];
}

interface Genre {
	name: string;
	count: number;
}

interface RawRelease {
	id: string;
	title: string;
	date?: string;
	'release-group': { id: string; 'first-release-date'?: string; genres?: Genre[] };
	genres?: Genre[];
	media: {
		position: number;
		'track-count': number;
		tracks?: {
			position: number;
			title: string;
			length?: number | null;
			recording: { id: string; length?: number | null };
			'artist-credit'?: ArtistCredit[];
		}[];
	}[];
}

export interface ReleaseTrack {
	index: number; // 1-based across all discs
	recordingId: string;
	disc: number;
	position: number;
	title: string;
	lengthMs?: number;
	credits: string[]; // artist names, primary first
}

export interface Release {
	id: string;
	title: string;
	releaseGroupId: string;
	year?: string; // original release year (release group's first release)
	genre?: string;
	discCount: number;
	tracksPerDisc: Record<number, number>;
	tracks: ReleaseTrack[];
}

// MusicBrainz allows ~1 req/s per client; every call goes through this chain.
let queue: Promise<unknown> = Promise.resolve();
let last = 0;

function throttled<T>(fn: () => Promise<T>): Promise<T> {
	const next = queue.then(async () => {
		const wait = last + 1100 - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		last = Date.now();
		return fn();
	});
	queue = next.catch(() => undefined);
	return next;
}

/** MusicBrainz requires a User-Agent with contact info: "app/version ( contact )". */
async function mb<T>(path: string, contact: string): Promise<T | undefined> {
	const ua = `napster/0.3 ( ${contact} )`;
	try {
		return await throttled(() => getJson<T>(`${API}${path}`, ua));
	} catch (err) {
		// 503 = rate limited; one retry after a pause.
		if (err instanceof Error && err.message.includes('503')) {
			await new Promise((r) => setTimeout(r, 3000));
			return throttled(() => getJson<T>(`${API}${path}`, ua));
		}
		throw err;
	}
}

export async function searchReleases(query: string, contact: string): Promise<SearchRelease[]> {
	const res = await mb<{ releases: SearchRelease[] }>(
		`/release?query=${encodeURIComponent(query)}&limit=25&fmt=json`,
		contact
	);
	return res?.releases ?? [];
}

export async function searchRecordings(query: string, contact: string): Promise<SearchRecording[]> {
	const res = await mb<{ recordings: SearchRecording[] }>(
		`/recording?query=${encodeURIComponent(query)}&limit=25&fmt=json`,
		contact
	);
	return res?.recordings ?? [];
}

function titleCase(s: string): string {
	return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

function toRelease(raw: RawRelease): Release {
	const tracks: ReleaseTrack[] = [];
	const tracksPerDisc: Record<number, number> = {};
	for (const medium of raw.media) {
		tracksPerDisc[medium.position] = medium['track-count'];
		for (const t of medium.tracks ?? []) {
			tracks.push({
				index: tracks.length + 1,
				recordingId: t.recording.id,
				disc: medium.position,
				position: t.position,
				title: t.title,
				lengthMs: t.length ?? t.recording.length ?? undefined,
				credits: (t['artist-credit'] ?? []).map((c) => c.name)
			});
		}
	}
	const genres = [...(raw['release-group'].genres ?? []), ...(raw.genres ?? [])].sort(
		(a, b) => b.count - a.count
	);
	const year = (raw['release-group']['first-release-date'] || raw.date)?.slice(0, 4);
	return {
		id: raw.id,
		title: raw.title,
		releaseGroupId: raw['release-group'].id,
		year: year || undefined,
		genre: genres[0] ? titleCase(genres[0].name) : undefined,
		discCount: raw.media.length,
		tracksPerDisc,
		tracks
	};
}

// Cache the lookup promise so repeated/parallel lookups of one release make one request.
const cache = new Map<string, Promise<Release | undefined>>();

export function getRelease(id: string, contact: string): Promise<Release | undefined> {
	let p = cache.get(id);
	if (!p) {
		p = mb<RawRelease>(
			`/release/${id}?inc=artist-credits+recordings+release-groups+genres&fmt=json`,
			contact
		).then((raw) => (raw ? toRelease(raw) : undefined));
		p.catch(() => cache.delete(id));
		cache.set(id, p);
		if (cache.size > 200) cache.delete(cache.keys().next().value!);
	}
	return p;
}
