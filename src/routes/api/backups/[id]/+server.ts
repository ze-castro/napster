import { error } from '@sveltejs/kit';
import { deleteBackup } from '$lib/server/backups';
import { forgetBackup } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		await deleteBackup(params.id);
		forgetBackup(params.id);
		return new Response(null, { status: 204 });
	} catch (err) {
		error(400, (err as Error).message);
	}
};
