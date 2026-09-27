import { error, json } from '@sveltejs/kit';
import { detail, healReview } from '$lib/server/reviews';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	// Finds files that moved since the review was made before reporting anything missing.
	const review = await healReview(params.id);
	if (!review) error(404, 'This review no longer exists.');
	return json(await detail(review));
};
