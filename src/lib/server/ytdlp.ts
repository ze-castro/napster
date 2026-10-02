import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cookieArgs } from './cookies';
import { run } from './proc';
import { MIN_AUDIO_KBPS } from './tagging';

export interface ResolvedEntry {
	videoId: string;
	title: string;
	/** Position in an album playlist; only trusted for album playlists (OLAK5uy_…). */
	albumIndex?: number;
}

export interface ResolvedUrl {
	kind: 'track' | 'playlist';
	title: string;
	entries: ResolvedEntry[];
}

/** Subset of yt-dlp's info JSON that we use. */
export interface YtInfo {
	id: string;
	title?: string;
	track?: string;
	artist?: string;
	artists?: string[];
	album?: string;
	album_artist?: string;
	album_artists?: string[];
	release_year?: number;
	release_date?: string;
	upload_date?: string;
	uploader?: string;
	duration?: number;
	format_id?: string;
	/** Bitrate of the selected source stream, kbps. */
	abr?: number;
}

export interface DownloadResult {
	audioPath: string;
	thumbnailPath?: string;
	info: YtInfo;
}

const ALLOWED_HOSTS = new Set(['music.youtube.com']);

/**
 * Validates the URL and decides track vs playlist. A watch URL often carries a
 * `list=RDAMVM…` radio mix, which is endless, so `v=` always wins.
 */
export function parseInput(raw: string): { url: string; kind: 'track' | 'playlist' } {
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		throw new Error('That is not a valid URL.');
	}
	if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
		throw new Error('Paste a link from music.youtube.com.');
	}

	const v = u.searchParams.get('v');
	if (u.pathname === '/watch' && v) {
		return { url: `https://music.youtube.com/watch?v=${encodeURIComponent(v)}`, kind: 'track' };
	}
	const list = u.searchParams.get('list');
	if (u.pathname === '/playlist' && list) {
		return {
			url: `https://music.youtube.com/playlist?list=${encodeURIComponent(list)}`,
			kind: 'playlist'
		};
	}
	if (u.pathname.startsWith('/browse/')) {
		// Album pages (MPREb_…); yt-dlp redirects these to the album playlist.
		return { url: `https://music.youtube.com${u.pathname}`, kind: 'playlist' };
	}
	throw new Error('Paste a song, album or playlist link.');
}

function baseArgs(): string[] {
	return [
		'--color',
		'never',
		// tv still serves 140/251 without a PO token; the others are fallbacks, in priority order.
		'--extractor-args',
		'youtube:player_client=tv,web_music,web_safari;playback_wait=0',
		'--sleep-requests',
		'1'
	];
}

/** Forwards yt-dlp's warnings and errors to the container log, tagged with what was being fetched. */
function logStderr(label: string) {
	return (line: string) => {
		if (line.startsWith('ERROR:')) console.error(`[napster] yt-dlp ${label}: ${line}`);
		else if (line.startsWith('WARNING:')) console.warn(`[napster] yt-dlp ${label}: ${line}`);
	};
}

/** Points at the likely fix when YouTube blocks an anonymous request. */
async function withCookieHint<T>(cookies: string[], p: Promise<T>): Promise<T> {
	try {
		return await p;
	} catch (err) {
		const msg = (err as Error).message;
		if (!cookies.length && /HTTP Error 403|Sign in to confirm/.test(msg)) {
			throw new Error(`${msg} Adding YouTube cookies in Settings usually fixes this.`);
		}
		throw err;
	}
}

// Every yt-dlp download is its own process, so yt-dlp's --sleep-interval never applies
// between songs. This spaces download starts 1–3 s apart across all parallel tracks and jobs.
let nextStart = 0;
async function waitTurn(): Promise<void> {
	const now = Date.now();
	const start = Math.max(now, nextStart);
	nextStart = start + 1000 + Math.random() * 2000;
	if (start > now) await new Promise((r) => setTimeout(r, start - now));
}

export async function resolveUrl(url: string, kind: 'track' | 'playlist', workDir: string): Promise<ResolvedUrl> {
	const cookies = await cookieArgs(workDir);
	if (kind === 'track') {
		const { stdout } = await withCookieHint(cookies, run('yt-dlp', [...baseArgs(), ...cookies, '-J', '--no-playlist', '--', url], undefined, undefined, logStderr(url)));
		const info = JSON.parse(stdout) as YtInfo;
		return {
			kind,
			title: info.track ?? info.title ?? info.id,
			entries: [{ videoId: info.id, title: info.track ?? info.title ?? info.id }]
		};
	}

	const { stdout } = await withCookieHint(cookies, run('yt-dlp', [...baseArgs(), ...cookies, '-J', '--flat-playlist', '--', url], undefined, undefined, logStderr(url)));
	const data = JSON.parse(stdout) as {
		id?: string;
		title?: string;
		entries?: { id?: string; title?: string }[];
	};
	const isAlbum = data.id?.startsWith('OLAK5uy_') ?? false;
	const entries = (data.entries ?? [])
		.filter((e): e is { id: string; title?: string } => typeof e.id === 'string')
		.map((e, i) => ({
			videoId: e.id,
			title: e.title ?? e.id,
			albumIndex: isAlbum ? i + 1 : undefined
		}));

	if (entries.length === 0) throw new Error('No tracks found at that link.');
	return { kind, title: (data.title ?? 'Playlist').replace(/^Album - /, ''), entries };
}

/**
 * 140 = AAC 128k (copied as-is). 251 = Opus ~130–160k (transcoded to AAC).
 * 139 (HE-AAC 48k) is only reachable through the last fallbacks.
 */
const FORMAT = '140/251/bestaudio[abr>=96]/bestaudio/best';
const ATTEMPTS = 2;

const isLowQuality = (info: YtInfo) =>
	info.format_id === '139' || (info.abr !== undefined && info.abr < MIN_AUDIO_KBPS);

/** yt-dlp skips files that already exist, so a retry needs a clean slate. */
async function clearDownload(dir: string) {
	for (const f of await readdir(dir)) {
		if (/^(audio|thumb|info)\./.test(f)) await rm(join(dir, f), { force: true });
	}
}

export async function download(
	videoId: string,
	dir: string,
	onProgress: (pct: number) => void
): Promise<DownloadResult> {
	let result = await downloadOnce(videoId, dir, onProgress);
	// YouTube's format list varies per request; a missing 140 often shows up on a second try.
	for (let i = 1; i < ATTEMPTS && isLowQuality(result.info); i++) {
		await clearDownload(dir);
		await new Promise((r) => setTimeout(r, 5000));
		result = await downloadOnce(videoId, dir, onProgress);
	}
	return result;
}

async function downloadOnce(
	videoId: string,
	dir: string,
	onProgress: (pct: number) => void
): Promise<DownloadResult> {
	const url = `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
	const cookies = await cookieArgs(dir);
	await waitTurn();
	await withCookieHint(cookies, run(
		'yt-dlp',
		[
			...baseArgs(),
			...cookies,
			'--no-playlist',
			'-f',
			FORMAT,
			'-x',
			'--audio-format',
			'm4a',
			'--audio-quality',
			'192K',
			'--write-info-json',
			'--write-thumbnail',
			'--convert-thumbnails',
			'jpg',
			'-o',
			join(dir, 'audio.%(ext)s'),
			'-o',
			`thumbnail:${join(dir, 'thumb.%(ext)s')}`,
			'-o',
			`infojson:${join(dir, 'info')}`,
			'--newline',
			'--progress-template',
			'download:napster %(progress._percent_str)s',
			'--',
			url
		],
		(line) => {
			const m = /napster\s+([\d.]+)%/.exec(line);
			if (m) onProgress(Number(m[1]));
		},
		undefined,
		logStderr(videoId)
	));

	const files = await readdir(dir);
	const audio = files.find((f) => f.startsWith('audio.') && f.endsWith('.m4a'));
	const infoFile = files.find((f) => f.endsWith('.info.json'));
	const thumb = files.find((f) => f.startsWith('thumb.') && f.endsWith('.jpg'));
	if (!audio || !infoFile) throw new Error('yt-dlp finished but the audio file is missing.');

	const info = JSON.parse(await readFile(join(dir, infoFile), 'utf8')) as YtInfo;
	return {
		audioPath: join(dir, audio),
		thumbnailPath: thumb ? join(dir, thumb) : undefined,
		info
	};
}
