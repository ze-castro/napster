import { error } from '@sveltejs/kit';
import { albumFolder, libraryRoot } from '$lib/server/library';
import { readSettings } from '$lib/server/settings';
import { folderThumbnail } from '$lib/server/thumbnails';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const path = url.searchParams.get('path');
	if (!path) error(400, 'Missing path.');
	let img: Buffer | undefined;
	try {
		const { root } = await libraryRoot(await readSettings());
		img = await folderThumbnail(await albumFolder(root, path)); // albumFolder blocks path traversal
	} catch (err) {
		error(400, (err as Error).message);
	}
	if (!img) error(404, 'No cover.');
	return new Response(new Uint8Array(img), {
		headers: {
			'Content-Type': 'image/jpeg',
			// The URL carries the folder's version, so a changed cover gets a new URL.
			'Cache-Control': 'private, max-age=31536000, immutable'
		}
	});
};
