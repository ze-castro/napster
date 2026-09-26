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
	type ArtSize,
	type ExistingFileMode,
	type Settings
} from '$lib/settings';
import { config } from './config';
import { readJson, writeJson } from './store';

const FILE = join(config.dataDir, 'settings.json');

export function defaultSettings(): Settings {
	return {
		libraryDir: dev ? join(homedir(), 'Downloads') : '/music',
		concurrency: 3,
		mbContact: '',
		owner: null,
		existingFiles: 'skip',
		artSize: 1000,
		cookieBrowser: '',
		cookieProfile: '',
		cookieAutoRefresh: false
	};
}

/** Read on every call so edits to settings.json on disk are picked up too. */
export async function readSettings(): Promise<Settings> {
	const raw = (await readJson<Partial<Settings>>(FILE)) ?? {};
	const d = defaultSettings();
	const owner = raw.owner;
	return {
		libraryDir: typeof raw.libraryDir === 'string' && isAbsolute(raw.libraryDir) ? raw.libraryDir : d.libraryDir,
		concurrency:
			Number.isInteger(raw.concurrency) && raw.concurrency! >= 1 && raw.concurrency! <= MAX_CONCURRENCY
				? raw.concurrency!
				: d.concurrency,
		mbContact: typeof raw.mbContact === 'string' ? raw.mbContact : d.mbContact,
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
		cookieAutoRefresh: raw.cookieAutoRefresh === true
	};
}

export function saveSettings(settings: Settings): Promise<void> {
	return writeJson(FILE, settings);
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
