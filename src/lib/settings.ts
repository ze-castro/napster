// Shared between server and client: types and option lists only.

/** 1000 is Deezer's largest cover; 500 saves space. */
export const ART_SIZES = [500, 1000] as const;
export type ArtSize = (typeof ART_SIZES)[number];

export const EXISTING_FILE_MODES = ['skip', 'overwrite', 'keep-both'] as const;
export type ExistingFileMode = (typeof EXISTING_FILE_MODES)[number];

export const MAX_CONCURRENCY = 8;

/** Browsers yt-dlp's --cookies-from-browser can read. */
export const COOKIE_BROWSERS = [
	'firefox',
	'chrome',
	'brave',
	'edge',
	'chromium',
	'opera',
	'vivaldi',
	'safari'
] as const;
export type CookieBrowser = (typeof COOKIE_BROWSERS)[number];

export interface FileOwner {
	uid: number;
	gid: number;
}

export interface Settings {
	libraryDir: string;
	concurrency: number;
	/** null = same owner as the music folder */
	owner: FileOwner | null;
	existingFiles: ExistingFileMode;
	artSize: ArtSize;
	/** '' = don't read cookies from a browser */
	cookieBrowser: CookieBrowser | '';
	cookieProfile: string;
	/** Re-import from the browser before every download job. */
	cookieAutoRefresh: boolean;
}

export interface SystemUser {
	name: string;
	uid: number;
	gid: number;
	group: string;
}
