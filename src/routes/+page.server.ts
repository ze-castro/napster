import { readSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const settings = await readSettings();
	return { libraryDir: settings.libraryDir, hasMbContact: settings.mbContact !== '' };
};
