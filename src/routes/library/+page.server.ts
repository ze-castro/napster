import { listBackups } from '$lib/server/backups';
import { readSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends }) => {
	depends('app:backups');
	const settings = await readSettings();
	return { libraryDir: settings.libraryDir, backups: await listBackups() };
};
