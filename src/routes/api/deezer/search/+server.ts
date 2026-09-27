import { error, json } from '@sveltejs/kit';
import { searchAlbums, searchTracks } from '$lib/server/deezer';
import type { RequestHandler } from './$types';

/** ?q=…&type=album|track, for picking the right Deezer release in a review. */
export const GET: RequestHandler = async ({ url }) => {
	const q = url.searchParams.get('q')?.trim().slice(0, 200);
	if (!q) error(400, 'Type something to search for.');
	try {
		return json(url.searchParams.get('type') === 'track' ? await searchTracks(q, 15) : await searchAlbums(q, 15));
	} catch (err) {
		error(502, (err as Error).message);
	}
};
