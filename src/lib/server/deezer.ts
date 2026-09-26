import { getJson } from './http';
import { sameish } from './text';

const API = 'https://api.deezer.com';

interface DeezerAlbum {
	title: string;
	cover_big?: string; // 500×500
	cover_xl?: string; // 1000×1000
	artist?: { name: string };
}

interface DeezerSearch<T> {
	data?: T[];
	error?: { message: string };
}

// Albums without art point at a generic placeholder with an empty hash: ".../cover//1000x1000-...".
function coverUrl(album: DeezerAlbum | undefined, size: number): string | undefined {
	const url = size <= 500 ? album?.cover_big : album?.cover_xl;
	return url && !url.includes('/cover//') ? url : undefined;
}

/** Deezer cover (500 or 1000 px) for an album, falling back to a track search. No API key needed. */
export async function findDeezerCover(opts: { artist: string; album?: string; title?: string; size: number }) {
	const { artist, album, title, size } = opts;
	if (album) {
		const q = `artist:"${artist}" album:"${album}"`;
		const res = await getJson<DeezerSearch<DeezerAlbum>>(`${API}/search/album?q=${encodeURIComponent(q)}&limit=10`);
		const hit =
			res?.data?.find((a) => sameish(a.title, album) && sameish(a.artist?.name, artist)) ??
			res?.data?.find((a) => sameish(a.title, album));
		const url = coverUrl(hit, size);
		if (url) return url;
	}
	if (title) {
		const q = `artist:"${artist}" track:"${title}"`;
		const res = await getJson<DeezerSearch<{ album: DeezerAlbum; artist?: { name: string } }>>(
			`${API}/search?q=${encodeURIComponent(q)}&limit=10`
		);
		const hit = res?.data?.find((t) => sameish(t.artist?.name, artist));
		const url = coverUrl(hit?.album, size);
		if (url) return url;
	}
	return undefined;
}
