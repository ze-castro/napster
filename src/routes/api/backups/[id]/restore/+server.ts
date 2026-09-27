import { error } from '@sveltejs/kit';
import { restoreBackup } from '$lib/server/backups';
import { markRestored } from '$lib/server/jobs';
import { recordMoves } from '$lib/server/moves';
import { relinkPaths } from '$lib/server/reviews';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	try {
		const moves = await restoreBackup(params.id);
		// Open reviews waiting on files the restore moved back follow them.
		await recordMoves(moves);
		await relinkPaths(moves);
		markRestored(params.id);
		return new Response(null, { status: 204 });
	} catch (err) {
		error(400, (err as Error).message);
	}
};
