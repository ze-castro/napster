import { error, json } from '@sveltejs/kit';
import { createRetagJob } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

/** { folders: string[] } re-tags each folder as its own album. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { folders?: unknown } | null;
	const folders = Array.isArray(body?.folders)
		? [...new Set(body.folders.filter((f): f is string => typeof f === 'string' && f !== ''))]
		: [];
	if (!folders.length) error(400, 'Pick at least one folder.');

	const started: string[] = [];
	const failed: { folder: string; message: string }[] = [];
	for (const folder of folders) {
		try {
			started.push((await createRetagJob(folder)).id);
		} catch (err) {
			failed.push({ folder, message: (err as Error).message });
		}
	}
	return json({ started, failed }, { status: started.length ? 201 : 400 });
};
