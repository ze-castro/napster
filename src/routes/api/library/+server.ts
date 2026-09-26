import { error, json } from '@sveltejs/kit';
import { libraryRoot, listAlbums } from '$lib/server/library';
import { readSettings } from '$lib/server/settings';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		const { root } = await libraryRoot(await readSettings());
		return json(await listAlbums(root));
	} catch (err) {
		error(400, (err as Error).message);
	}
};
