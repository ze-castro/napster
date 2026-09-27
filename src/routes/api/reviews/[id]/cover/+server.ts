import { error } from '@sveltejs/kit';
import { readFile } from 'node:fs/promises';
import { currentCoverPath, getReview } from '$lib/server/reviews';
import type { RequestHandler } from './$types';

/** The cover we already have for a review (YouTube thumbnail or embedded cover). */
export const GET: RequestHandler = async ({ params }) => {
	const review = await getReview(params.id);
	const path = review && (await currentCoverPath(review));
	const img = path && (await readFile(path).catch(() => undefined));
	if (!img) error(404, 'No cover.');
	return new Response(new Uint8Array(img), {
		headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }
	});
};
