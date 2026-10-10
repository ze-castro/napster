import { dev } from '$app/environment';
import { access, constants, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
	ART_SIZES,
	COOKIE_BROWSERS,
	type CookieBrowser,
	EXISTING_FILE_MODES,
	MAX_CONCURRENCY,
	PLAYER_CLIENTS_PATTERN,
	type ArtSize,
	type ExistingFileMode,
	type Settings
} from '$lib/settings';
import { db } from './db';

export function defaultSettings(): Settings {
	return {
		libraryDir: dev ? join(homedir(), 'Downloads') : '/music',
		concurrency: 3,
		owner: null,
		existingFiles: 'skip',
		artSize: 1000,
		cookieBrowser: '',
		cookieProfile: '',
		cookieAutoRefresh: false,
		playerClients: ''
	};
}

const selectAll = db.query<{ key: string; value: string }, []>('SELECT key, value FROM settings');
const upsert = db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');

function stored(): Partial<Settings> {
	const raw: Record<string, unknown> = {};
	for (const { key, value } of selectAll.all()) {
		try {
			raw[key] = JSON.parse(value);
		} catch {
			// unreadable value: the default applies
		}
	}
	return raw as Partial<Settings>;
}

/** Stored values are validated on every read, so a bad row falls back to its default. */
export async function readSettings(): Promise<Settings> {
	const raw = stored();
	const d = defaultSettings();
	const owner = raw.owner;
	return {
		libraryDir: typeof raw.libraryDir === 'string' && isAbsolute(raw.libraryDir) ? raw.libraryDir : d.libraryDir,
		concurrency:
			Number.isInteger(raw.concurrency) && raw.concurrency! >= 1 && raw.concurrency! <= MAX_CONCURRENCY
				? raw.concurrency!
				: d.concurrency,
		owner:
			owner && Number.isInteger(owner.uid) && Number.isInteger(owner.gid)
				? { uid: owner.uid, gid: owner.gid }
				: null,
		existingFiles: EXISTING_FILE_MODES.includes(raw.existingFiles as ExistingFileMode)
			? (raw.existingFiles as ExistingFileMode)
			: d.existingFiles,
		// Older versions offered 800/1200/1600: round to the nearest size we still offer.
		artSize: ART_SIZES.includes(raw.artSize as ArtSize)
			? (raw.artSize as ArtSize)
			: typeof raw.artSize === 'number' && raw.artSize <= 600
				? 500
				: d.artSize,
		cookieBrowser: COOKIE_BROWSERS.includes(raw.cookieBrowser as CookieBrowser)
			? (raw.cookieBrowser as CookieBrowser)
			: '',
		cookieProfile: typeof raw.cookieProfile === 'string' ? raw.cookieProfile : '',
		cookieAutoRefresh: raw.cookieAutoRefresh === true,
		playerClients:
			typeof raw.playerClients === 'string' && PLAYER_CLIENTS_PATTERN.test(raw.playerClients) ? raw.playerClients : ''
	};
}

export async function saveSettings(settings: Settings): Promise<void> {
	db.transaction(() => {
		for (const [key, value] of Object.entries(settings)) upsert.run(key, JSON.stringify(value));
	})();
}

/** Returns an error message, or undefined if the folder is usable. */
export async function checkLibraryDir(path: string): Promise<string | undefined> {
	if (!isAbsolute(path)) return 'Use an absolute path, e.g. /music.';
	const s = await stat(path).catch(() => undefined);
	if (!s) return 'Folder not found. It must exist already and be mounted in compose.yaml.';
	if (!s.isDirectory()) return 'That path is a file, not a folder.';
	try {
		await access(path, constants.W_OK);
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EROFS'
			? 'Folder is mounted read-only. Remove :ro from its volume in compose.yaml.'
			: 'The app has no write permission in that folder.';
	}
	return undefined;
}
