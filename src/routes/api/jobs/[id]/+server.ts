import { error } from '@sveltejs/kit';
import { removeJob } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

/** Removes one finished job from the history. */
export const DELETE: RequestHandler = async ({ params }) => {
	try {
		await removeJob(params.id);
		return new Response(null, { status: 204 });
	} catch (err) {
		error(400, (err as Error).message);
	}
};
