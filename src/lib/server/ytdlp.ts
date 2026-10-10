import { env } from '$env/dynamic/private';
import { mkdir, readdir, readFile } from 'node:fs/promises';
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

const MUSIC = 'https://music.youtube.com';
const YOUTUBE_HOSTS = new Set(['music.youtube.com', 'www.youtube.com', 'youtube.com', 'm.youtube.com']);

/**
 * Validates the URL and decides track vs playlist. A watch URL often carries a
 * `list=RDAMVM…` radio mix, which is endless, so `v=` always wins.
 * Plain YouTube links are accepted too and read through YouTube Music.
 */
export function parseInput(raw: string): { url: string; kind: 'track' | 'playlist'; videoId?: string } {
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		throw new Error('That is not a valid link.');
	}
	const track = (v: string) => ({ url: `${MUSIC}/watch?v=${encodeURIComponent(v)}`, kind: 'track' as const, videoId: v });

	if (u.protocol === 'https:' && u.hostname === 'youtu.be' && VIDEO_ID.test(u.pathname.slice(1))) {
		return track(u.pathname.slice(1));
	}
	if (u.protocol !== 'https:' || !YOUTUBE_HOSTS.has(u.hostname)) {
		throw new Error('Paste a link from music.youtube.com.');
	}

	const v = u.searchParams.get('v');
	if (u.pathname === '/watch' && v) {
		if (!VIDEO_ID.test(v)) throw new Error('That link has no valid song id.');
		return track(v);
	}
	const list = u.searchParams.get('list');
	if (u.pathname === '/playlist' && list) {
		return { url: `${MUSIC}/playlist?list=${encodeURIComponent(list)}`, kind: 'playlist' };
	}
	if (u.pathname.startsWith('/browse/')) {
		// Album pages (MPREb_…); yt-dlp redirects these to the album playlist.
		return { url: `${MUSIC}${u.pathname}`, kind: 'playlist' };
	}
	throw new Error('Paste a song, album or playlist link.');
}

const VIDEO_ID = /^[\w-]{11}$/;

/**
 * Arguments every yt-dlp call gets. The PO token provider (a sidecar container, see
 * compose.yaml) lets yt-dlp answer YouTube's "proof of origin" check; without one, yt-dlp
 * simply skips the formats that need a token.
 */
function baseArgs(): string[] {
	const args = ['--color', 'never', '--sleep-requests', '1'];
	if (env.POT_PROVIDER_URL) {
		args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${env.POT_PROVIDER_URL}`);
	}
	return args;
}

/** Forwards yt-dlp's warnings and errors to the container log, tagged with what was being fetched. */
function logStderr(label: string) {
	return (line: string) => {
		if (line.startsWith('ERROR:')) console.error(`[napster] yt-dlp ${label}: ${line}`);
		else if (line.startsWith('WARNING:')) console.warn(`[napster] yt-dlp ${label}: ${line}`);
	};
}

// ---------------------------------------------------------------- errors

/** A failure with a short explanation for the list and yt-dlp's own words for the details. */
export class DownloadError extends Error {
	constructor(
		message: string,
		readonly detail: string
	) {
		super(message);
	}
}

/** YouTube says the song itself can't be had; trying another way won't help. */
const PERMANENT =
	/Video unavailable|Private video|has been removed|not available in your country|members-only|Join this channel|Music Premium/i;

/** Turns yt-dlp's stderr into one sentence that says what to do about it. */
export function explain(raw: string, hasCookies: boolean): string {
	const reason = /ERROR: (?:\[[^\]]+\] )?(?:[\w-]{11}: )?(.+)/.exec(raw)?.[1]?.trim();
	if (PERMANENT.test(raw)) return reason ?? 'YouTube says this song is unavailable.';
	if (/cookies are no longer valid/i.test(raw)) {
		return 'The saved YouTube cookies have expired. Export new ones in Settings.';
	}
	if (/Sign in to confirm|LOGIN_REQUIRED/i.test(raw)) {
		return hasCookies
			? 'YouTube asked this session to sign in again. Refresh the YouTube cookies in Settings.'
			: 'YouTube wants a signed-in session from this network. Add YouTube cookies in Settings.';
	}
	if (/page needs to be reloaded/i.test(raw)) {
		return 'YouTube turned the request down (“The page needs to be reloaded”). It usually works again after a while; updating yt-dlp helps when it doesn’t.';
	}
	if (/PO Token|HTTP Error 403|file is empty|Only images are available|Requested format is not available/i.test(raw)) {
		return hasCookies
			? 'YouTube refused to hand over the audio (it wants a PO token). Check that the PO token provider is running, or try again later.'
			: 'YouTube refused to hand over the audio (it wants a PO token). Check that the PO token provider is running, or add YouTube cookies in Settings.';
	}
	if (/HTTP Error 429|Too Many Requests/i.test(raw)) {
		return 'YouTube is rate-limiting this network. Wait a while and lower “songs at the same time” in Settings.';
	}
	if (/ENOENT|not found|No such file/i.test(raw) && /yt-dlp/.test(raw) && !reason) {
		return 'yt-dlp is not installed.';
	}
	return reason ?? raw.split('\n').pop() ?? 'yt-dlp failed.';
}

// ---------------------------------------------------------------- ways to ask YouTube

/**
 * 140 = AAC 128k (copied as-is). 251 = Opus ~130–160k (transcoded to AAC).
 * 139 (HE-AAC 48k) is only reachable through the last fallbacks.
 */
const FORMAT = '140/251/bestaudio[abr>=96]/bestaudio/best';
/** The HLS variant of the same AAC stream; served by a different path that needs no PO token. */
const HLS_FORMAT = 'bestaudio[protocol^=m3u8]/best[protocol^=m3u8]';

interface Strategy {
	id: string;
	label: string;
	/** yt-dlp player clients; undefined = whatever the installed yt-dlp defaults to. */
	clients?: string;
	cookies: boolean;
	format: string;
}

/**
 * YouTube keeps changing which of its apps ("player clients") may fetch audio, and how.
 * Pinning one client breaks every few months, so: start with yt-dlp's own defaults, which
 * follow those changes, and on failure ask again in a different way.
 */
function strategies(hasCookies: boolean, custom: string): Strategy[] {
	const list: Strategy[] = [];
	if (custom) {
		list.push({ id: 'custom', label: `player clients ${custom}`, clients: custom, cookies: hasCookies, format: FORMAT });
	}
	list.push({ id: 'auto', label: 'yt-dlp defaults', cookies: hasCookies, format: FORMAT });
	// A flagged or expired session can be turned away where an anonymous one is not.
	if (hasCookies) list.push({ id: 'anonymous', label: 'yt-dlp defaults, signed out', cookies: false, format: FORMAT });
	list.push({
		id: 'web',
		label: 'web clients',
		clients: 'web_embedded,web_music,mweb',
		cookies: hasCookies,
		format: FORMAT
	});
	list.push({ id: 'hls', label: 'HLS stream', cookies: false, format: HLS_FORMAT });
	return list;
}

/** The way that last worked goes first, so a 50-song album doesn't rediscover it 50 times. */
let preferred: string | undefined;

function ordered(list: Strategy[]): Strategy[] {
	const first = list.find((s) => s.id === preferred);
	return first ? [first, ...list.filter((s) => s !== first)] : list;
}

function clientArgs(s: Strategy): string[] {
	return ['--extractor-args', `youtube:${s.clients ? `player_client=${s.clients};` : ''}playback_wait=0`];
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

// ---------------------------------------------------------------- resolving a link

/**
 * Lists what a link holds. A song link needs no request at all: the id is in the URL and its
 * title arrives with the download. Albums and playlists are read from YouTube's playlist API,
 * which doesn't depend on player clients.
 */
export async function resolveUrl(
	input: { url: string; kind: 'track' | 'playlist'; videoId?: string },
	workDir: string
): Promise<ResolvedUrl> {
	if (input.kind === 'track' && input.videoId) {
		return { kind: 'track', title: '', entries: [{ videoId: input.videoId, title: '' }] };
	}

	const cookies = await cookieArgs(workDir);
	let stdout: string;
	try {
		({ stdout } = await run(
			'yt-dlp',
			[...baseArgs(), ...cookies, '-J', '--flat-playlist', '--', input.url],
			undefined,
			undefined,
			logStderr(input.url)
		));
	} catch (err) {
		const raw = (err as Error).message;
		throw new DownloadError(explain(raw, cookies.length > 0), raw);
	}
	const data = JSON.parse(stdout) as {
		id?: string;
		title?: string;
		entries?: { id?: string; title?: string }[];
	};
	const isAlbum = data.id?.startsWith('OLAK5uy_') ?? false;
	const seen = new Set<string>();
	const entries = (data.entries ?? [])
		.filter((e): e is { id: string; title?: string } => typeof e.id === 'string')
		// A playlist can hold the same song twice; one copy is enough.
		.filter((e) => !seen.has(e.id) && seen.add(e.id))
		.map((e, i) => ({
			videoId: e.id,
			title: e.title ?? e.id,
			albumIndex: isAlbum ? i + 1 : undefined
		}));

	if (entries.length === 0) throw new Error('No tracks found at that link.');
	return { kind: 'playlist', title: (data.title ?? 'Playlist').replace(/^Album - /, ''), entries };
}

// ---------------------------------------------------------------- downloading

const isLowQuality = (info: YtInfo) =>
	info.format_id === '139' || (info.abr !== undefined && info.abr < MIN_AUDIO_KBPS);

export interface DownloadOptions {
	/** Settings → advanced: player clients to try before the automatic ones. */
	playerClients: string;
	onProgress: (pct: number) => void;
	/** The song's real title, known just before its audio starts downloading. */
	onTitle?: (title: string, artist?: string) => void;
}

/**
 * Downloads one song, working down the list of strategies until one delivers.
 * A 48 kbps result gets one more try a different way; YouTube's format list varies per request.
 */
export async function download(videoId: string, dir: string, opts: DownloadOptions): Promise<DownloadResult> {
	const hasCookies = (await cookieArgs(dir)).length > 0;
	const list = ordered(strategies(hasCookies, opts.playerClients));
	const failures: { strategy: Strategy; raw: string }[] = [];
	let lowQuality: DownloadResult | undefined;

	for (const [i, strategy] of list.entries()) {
		const attemptDir = join(dir, `try-${i}`);
		await mkdir(attemptDir, { recursive: true });
		try {
			const result = await downloadOnce(videoId, attemptDir, strategy, opts);
			if (!isLowQuality(result.info)) {
				preferred = strategy.id;
				return result;
			}
			if (lowQuality) return result; // second low-quality answer: that's what YouTube has
			lowQuality = result;
		} catch (err) {
			if (lowQuality) return lowQuality;
			const raw = (err as Error).message;
			failures.push({ strategy, raw });
			if (PERMANENT.test(raw)) break;
		}
		opts.onProgress(0);
	}
	if (lowQuality) return lowQuality;

	// The first failure is the most telling one: later strategies are increasingly long shots.
	const detail = failures.map((f) => `${f.strategy.label}: ${f.raw}`).join('\n\n');
	throw new DownloadError(explain(failures[0]?.raw ?? '', hasCookies), detail);
}

async function downloadOnce(
	videoId: string,
	dir: string,
	strategy: Strategy,
	opts: DownloadOptions
): Promise<DownloadResult> {
	const url = `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
	const cookies = strategy.cookies ? await cookieArgs(dir) : [];
	await waitTurn();
	let title: string | undefined;
	await run(
		'yt-dlp',
		[
			...baseArgs(),
			...clientArgs(strategy),
			...cookies,
			'--no-playlist',
			'-f',
			strategy.format,
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
			// --print turns on --quiet; --progress keeps the progress lines coming.
			'--print',
			'before_dl:napster-title %(track,title)s',
			'--print',
			'before_dl:napster-artist %(artists.0,artist,uploader|)s',
			'--progress',
			'--newline',
			'--progress-template',
			'download:napster %(progress._percent_str)s',
			'--',
			url
		],
		(line) => {
			const m = /^napster\s+([\d.]+)%/.exec(line);
			if (m) return opts.onProgress(Number(m[1]));
			const t = /^napster-title (.+)/.exec(line);
			if (t) title = t[1];
			const a = /^napster-artist (.*)/.exec(line);
			if (a && title) opts.onTitle?.(title, a[1].replace(/ - Topic$/, '') || undefined);
		},
		undefined,
		logStderr(`${videoId} (${strategy.label})`)
	);

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

// ---------------------------------------------------------------- status

export interface DownloaderStatus {
	/** undefined when yt-dlp can't be run at all. */
	ytdlpVersion?: string;
	potProvider: 'ok' | 'unreachable' | 'not-configured';
	potProviderVersion?: string;
}

/** For Settings: is the downloader set up to get past YouTube's checks? */
export async function downloaderStatus(): Promise<DownloaderStatus> {
	const version = run('yt-dlp', ['--version'], undefined, 10_000).then(
		(r) => r.stdout.trim() || undefined,
		() => undefined
	);
	const base = env.POT_PROVIDER_URL;
	const pot = !base
		? Promise.resolve({ potProvider: 'not-configured' as const })
		: fetch(new URL('/ping', base), { signal: AbortSignal.timeout(3000) }).then(
				async (res) => {
					if (!res.ok) return { potProvider: 'unreachable' as const };
					const body = (await res.json().catch(() => null)) as { version?: string } | null;
					return { potProvider: 'ok' as const, potProviderVersion: body?.version };
				},
				() => ({ potProvider: 'unreachable' as const })
			);
	return { ytdlpVersion: await version, ...(await pot) };
}
