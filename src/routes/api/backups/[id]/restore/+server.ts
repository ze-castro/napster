import { error } from '@sveltejs/kit';
import { restoreBackup } from '$lib/server/backups';
import { markRestored } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	try {
		await restoreBackup(params.id);
		markRestored(params.id);
		return new Response(null, { status: 204 });
	} catch (err) {
		error(400, (err as Error).message);
	}
};
