import { error, json } from '@sveltejs/kit';
import { createRetagJob, waitForReview } from '$lib/server/jobs';
import { libraryRoot } from '$lib/server/library';
import { reviewForFolder } from '$lib/server/reviews';
import { readSettings } from '$lib/server/settings';
import type { RequestHandler } from './$types';

/** { folder } → opens the tag editor for a library folder. Returns the review to open. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { folder?: unknown } | null;
	if (typeof body?.folder !== 'string' || !body.folder) error(400, 'Missing folder.');
	try {
		// Songs from this folder already waiting: open that review instead of making another.
		const { root } = await libraryRoot(await readSettings());
		const existing = await reviewForFolder(root, body.folder);
		if (existing) return json({ reviewId: existing.id });

		const job = await createRetagJob(body.folder, 'auto', true);
		const reviewId = await waitForReview(job.id);
		if (!reviewId) error(400, job.error ?? 'Could not read that folder.');
		return json({ reviewId });
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		error(400, (err as Error).message);
	}
};
