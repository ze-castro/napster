import { error, json } from '@sveltejs/kit';
import { retryJob } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

/** Downloads the failed songs of a finished job again. */
export const POST: RequestHandler = async ({ params }) => {
	try {
		return json(await retryJob(params.id));
	} catch (err) {
		error(400, (err as Error).message);
	}
};
