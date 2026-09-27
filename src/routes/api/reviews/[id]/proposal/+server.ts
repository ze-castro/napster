import { error, json } from '@sveltejs/kit';
import { albumOfTrack } from '$lib/server/deezer';
import { proposalForAlbum, proposalForTrack } from '$lib/server/match';
import { getReview } from '$lib/server/reviews';
import { readSettings } from '$lib/server/settings';
import type { RequestHandler } from './$types';

/** A picked Deezer album (?album=ID) or song (?track=ID) mapped onto the review's songs. */
export const GET: RequestHandler = async ({ params, url }) => {
	const review = await getReview(params.id);
	if (!review) error(404, 'This review no longer exists.');
	const albumParam = Number(url.searchParams.get('album'));
	const trackParam = Number(url.searchParams.get('track'));
	const { artSize } = await readSettings();

	try {
		let proposal;
		if (trackParam > 0) {
			const albumId = albumParam > 0 ? albumParam : await albumOfTrack(trackParam);
			if (!albumId) error(404, 'Deezer has no album for that song.');
			proposal =
				review.sources.length === 1
					? await proposalForTrack(review.sources[0], trackParam, albumId, artSize)
					: await proposalForAlbum(review.sources, albumId, artSize);
		} else if (albumParam > 0) {
			proposal = await proposalForAlbum(review.sources, albumParam, artSize);
		} else error(400, 'Pick an album or a song.');
		if (!proposal) error(404, 'Deezer returned nothing for that pick.');
		return json(proposal);
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		error(502, (err as Error).message);
	}
};
