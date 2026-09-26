import { json } from '@sveltejs/kit';
import { deleteAllBackups } from '$lib/server/backups';
import { forgetBackup } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async () => {
	const deleted = await deleteAllBackups();
	forgetBackup();
	return json({ deleted });
};
