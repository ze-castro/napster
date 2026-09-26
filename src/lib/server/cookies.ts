import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CookieBrowser } from '$lib/settings';
import { config } from './config';
import { run } from './proc';

const FILE = join(config.dataDir, 'cookies.txt');
const MAX_BYTES = 1024 * 1024;

export interface CookieStatus {
	present: boolean;
	youtubeCookies: number;
	savedAt?: number;
	/** Earliest expiry of the sign-in cookies (…SID…), in ms. */
	expiresAt?: number;
}

interface Parsed {
	youtubeCookies: number;
	expiresAt?: number;
}

/** Validates Netscape cookies.txt format (what yt-dlp expects) and that it has YouTube sign-in cookies. */
export function parseCookies(text: string): Parsed | { error: string } {
	if (!text.trim()) return { error: 'The file is empty.' };
	if (Buffer.byteLength(text) > MAX_BYTES) return { error: 'That file is too large to be a cookies.txt.' };

	let youtubeCookies = 0;
	let hasSignIn = false;
	let expiresAt: number | undefined;

	for (const raw of text.split(/\r?\n/)) {
		// "#HttpOnly_" lines are real cookies; other "#" lines are comments.
		if (!isCookieLine(raw)) continue;
		const line = raw.startsWith('#HttpOnly_') ? raw.slice('#HttpOnly_'.length) : raw;
		const fields = line.split('\t');
		if (fields.length !== 7) {
			return { error: 'Not a Netscape cookies.txt file. Export with “Get cookies.txt LOCALLY” or “cookies.txt”.' };
		}
		const [domain, , , , expiry, name] = fields;
		if (!/(^|\.)youtube\.com$/.test(domain)) continue;
		youtubeCookies++;
		if (name.includes('SID')) {
			hasSignIn = true;
			const exp = Number(expiry) * 1000;
			if (exp > 0 && (expiresAt === undefined || exp < expiresAt)) expiresAt = exp;
		}
	}

	if (!youtubeCookies) return { error: 'No youtube.com cookies in that file. Export them from a music.youtube.com tab.' };
	if (!hasSignIn) return { error: 'These cookies are from a signed-out session. Sign in to YouTube first, then export.' };
	return { youtubeCookies, expiresAt };
}

const isCookieLine = (raw: string) => {
	const line = raw.startsWith('#HttpOnly_') ? raw.slice('#HttpOnly_'.length) : raw;
	return !!line.trim() && !line.startsWith('#');
};

/** Keeps only youtube.com cookies; nothing else from the browser is ever stored. */
export function youtubeOnly(text: string): string {
	const lines = text.split(/\r?\n/).filter((raw) => {
		if (!isCookieLine(raw)) return false;
		const line = raw.startsWith('#HttpOnly_') ? raw.slice('#HttpOnly_'.length) : raw;
		return /(^|\.)youtube\.com$/.test(line.split('\t')[0]);
	});
	return ['# Netscape HTTP Cookie File', ...lines, ''].join('\n');
}

/** Atomic write (a download copying the file never sees half of it), owner-only permissions. */
export async function saveCookies(text: string): Promise<void> {
	await mkdir(config.dataDir, { recursive: true });
	const tmp = `${FILE}.${randomUUID()}.tmp`;
	// Session cookies give access to the Google account.
	await writeFile(tmp, youtubeOnly(text), { mode: 0o600 });
	await chmod(tmp, 0o600);
	await rename(tmp, FILE);
}

let importing: Promise<Parsed> | undefined;

/**
 * Same as `yt-dlp --cookies-from-browser`: reads the signed-in session straight from the
 * browser's profile. Only works when napster runs on the computer that has the browser.
 * Parallel callers share one import.
 */
export function importFromBrowser(browser: CookieBrowser, profile: string): Promise<Parsed> {
	importing ??= (async () => {
		const dir = join(config.workDir, `cookies-${randomUUID()}`);
		// The raw export holds every cookie in the browser; keep it private and short-lived.
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const out = join(dir, 'all.txt');
		let runError: Error | undefined;
		try {
			await run(
				'yt-dlp',
				[
					'--cookies-from-browser',
					profile ? `${browser}:${profile}` : browser,
					'--cookies',
					out,
					'--flat-playlist',
					'--skip-download',
					'--quiet',
					'--no-warnings',
					'https://www.youtube.com'
				],
				undefined,
				// Chromium browsers on macOS wait for a Keychain prompt; don't hang forever.
				90_000
			).catch((err: Error) => (runError = err));

			// yt-dlp saves the cookie jar even when the page itself fails, so check the file.
			const text = await readFile(out, 'utf8').catch(() => '');
			if (!text) {
				throw new Error(
					`Could not read cookies from ${browser}. Check that it's installed, signed in to YouTube, and that the profile name is right.${runError ? ` (${runError.message})` : ''}`
				);
			}
			const filtered = youtubeOnly(text);
			const parsed = parseCookies(filtered);
			if ('error' in parsed) {
				throw new Error(`${browser} has no signed-in YouTube session. Sign in at music.youtube.com in ${browser} first.`);
			}
			await saveCookies(filtered);
			return parsed;
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	})().finally(() => (importing = undefined));
	return importing;
}

export async function removeCookies(): Promise<void> {
	await unlink(FILE).catch(() => undefined);
}

/** Status only; the cookie values never leave the server. */
export async function cookieStatus(): Promise<CookieStatus> {
	const s = await stat(FILE).catch(() => undefined);
	if (!s) return { present: false, youtubeCookies: 0 };
	const parsed = parseCookies(await readFile(FILE, 'utf8'));
	if ('error' in parsed) return { present: true, youtubeCookies: 0, savedAt: s.mtimeMs };
	return { present: true, youtubeCookies: parsed.youtubeCookies, savedAt: s.mtimeMs, expiresAt: parsed.expiresAt };
}

/**
 * yt-dlp rewrites its cookie file as it runs; parallel downloads sharing one file could
 * corrupt it. Each run gets its own copy inside its work folder, which is deleted afterwards.
 */
export async function cookieArgs(dir: string): Promise<string[]> {
	if (!(await stat(FILE).catch(() => undefined))) return [];
	await mkdir(dir, { recursive: true });
	const copy = join(dir, 'cookies.txt');
	await copyFile(FILE, copy);
	await chmod(copy, 0o600);
	return ['--cookies', copy];
}
