import { error } from '@sveltejs/kit';
import { discardReview } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	try {
		await discardReview(params.id);
		return new Response(null, { status: 204 });
	} catch (err) {
		error(400, (err as Error).message);
	}
};
