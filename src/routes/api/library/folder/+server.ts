import { error, json } from '@sveltejs/kit';
import { basename } from 'node:path';
import { albumFolder, audioFilesIn, libraryRoot } from '$lib/server/library';
import { readSettings } from '$lib/server/settings';
import { probeFile } from '$lib/server/tagging';
import type { LibraryTrack } from '$lib/types';
import type { RequestHandler } from './$types';

/** The songs in one folder with their current tags. */
export const GET: RequestHandler = async ({ url }) => {
	const path = url.searchParams.get('path');
	if (!path) error(400, 'Missing path.');
	try {
		const { root } = await libraryRoot(await readSettings());
		const files = await audioFilesIn(await albumFolder(root, path));
		const tracks: LibraryTrack[] = await Promise.all(
			files.map(async (f) => {
				const { tags, durationSec } = await probeFile(f).catch(() => ({ tags: {} as Record<string, string>, durationSec: undefined }));
				return {
					file: basename(f),
					title: tags.title,
					artist: tags.artist,
					albumArtist: tags.album_artist,
					album: tags.album,
					track: tags.track,
					year: tags.date?.slice(0, 4),
					durationSec
				};
			})
		);
		return json(tracks);
	} catch (err) {
		error(400, (err as Error).message);
	}
};
