import { error, json } from '@sveltejs/kit';
import { clearFinished, createJob, listJobs, ready } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	await ready;
	return json(listJobs());
};

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { url?: unknown } | null;
	if (typeof body?.url !== 'string') error(400, 'Missing url.');
	try {
		return json(await createJob(body.url), { status: 201 });
	} catch (err) {
		error(400, (err as Error).message);
	}
};

/** ?kind=download|retag clears finished jobs of that kind from the history. */
export const DELETE: RequestHandler = async ({ url }) => {
	const kind = url.searchParams.get('kind');
	if (kind !== 'download' && kind !== 'retag') error(400, 'kind must be download or retag.');
	await ready;
	return json({ removed: clearFinished(kind) });
};
