import { error, json } from '@sveltejs/kit';
import { parseCookies, saveCookies } from '$lib/server/cookies';
import type { RequestHandler } from './$types';

/**
 * Used by scripts/sync-cookies.sh. PUT with application/octet-stream can't be sent
 * cross-site without a CORS preflight, so other websites can't overwrite the cookies.
 */
export const PUT: RequestHandler = async ({ request }) => {
	if (request.headers.get('content-type') !== 'application/octet-stream') {
		error(415, 'Send the cookies.txt body as application/octet-stream.');
	}
	const text = await request.text();
	const parsed = parseCookies(text);
	if ('error' in parsed) error(400, parsed.error);
	await saveCookies(text);
	return json({ youtubeCookies: parsed.youtubeCookies, expiresAt: parsed.expiresAt });
};
