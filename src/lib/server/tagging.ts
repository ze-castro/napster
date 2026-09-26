import { run } from './proc';
import { REQUIRED_TAGS, type Tags } from './tags';

/** Remuxes (no re-encode) with fresh tags and the cover as an attached picture. */
export async function writeTags(audio: string, cover: string, tags: Tags, output: string) {
	const meta: [string, string | undefined][] = [
		['title', tags.title],
		['artist', tags.artist],
		['album_artist', tags.albumArtist],
		['album', tags.album],
		['track', tags.trackNumber ? `${tags.trackNumber}${tags.trackCount ? `/${tags.trackCount}` : ''}` : undefined],
		['disc', tags.discNumber ? `${tags.discNumber}${tags.discCount ? `/${tags.discCount}` : ''}` : undefined],
		['date', tags.year],
		['genre', tags.genre],
		['compilation', tags.compilation ? '1' : undefined]
	];

	const args = [
		'-hide_banner',
		'-loglevel',
		'error',
		'-y',
		'-i',
		audio,
		'-i',
		cover,
		'-map',
		'0:a:0',
		'-map',
		'1:v:0',
		'-map_metadata',
		'-1',
		'-c',
		'copy',
		'-disposition:v:0',
		'attached_pic'
	];
	for (const [k, v] of meta) if (v) args.push('-metadata', `${k}=${v}`);
	args.push('-movflags', '+faststart', '-f', 'ipod', output);

	await run('ffmpeg', args);
}

interface Probe {
	format?: { tags?: Record<string, string>; duration?: string };
	streams?: {
		codec_type: string;
		codec_name?: string;
		width?: number;
		height?: number;
		disposition?: { attached_pic?: number };
	}[];
}

export interface Verification {
	artOk: boolean;
	missing: string[];
	mismatched: string[];
}

const PROBE_KEYS: Record<(typeof REQUIRED_TAGS)[number], string> = {
	title: 'title',
	artist: 'artist',
	albumArtist: 'album_artist',
	album: 'album',
	trackNumber: 'track',
	year: 'date'
};

/** Reads the finished file back and checks tags and cover art against what we meant to write. */
export async function verify(file: string, expected: Tags): Promise<Verification> {
	const { stdout } = await run('ffprobe', [
		'-v',
		'error',
		'-show_entries',
		'format=duration:format_tags:stream=codec_type,codec_name,width,height:stream_disposition=attached_pic',
		'-of',
		'json',
		file
	]);
	const probe = JSON.parse(stdout) as Probe;
	const tags = Object.fromEntries(
		Object.entries(probe.format?.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v])
	);

	const audio = probe.streams?.find((s) => s.codec_type === 'audio');
	const pic = probe.streams?.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic);
	const artOk = !!pic?.width && pic.width === pic.height && pic.width >= 300;

	const missing: string[] = [];
	const mismatched: string[] = [];
	if (audio?.codec_name !== 'aac') mismatched.push('codec');
	if (!Number(probe.format?.duration)) missing.push('duration');

	for (const key of REQUIRED_TAGS) {
		const actual = tags[PROBE_KEYS[key]];
		const want = expected[key];
		if (!actual) missing.push(key);
		else if (want !== undefined) {
			// "track" is stored as "3/12"; "date" may be a full date.
			const got = key === 'trackNumber' ? actual.split('/')[0] : actual;
			if (key === 'year' ? !got.startsWith(String(want)) : got !== String(want)) mismatched.push(key);
		}
	}
	return { artOk, missing, mismatched };
}

/** Reads a file's current tags (lowercased keys) and duration. */
export async function probeFile(file: string): Promise<{ tags: Record<string, string>; durationSec?: number }> {
	const { stdout } = await run('ffprobe', [
		'-v',
		'error',
		'-show_entries',
		'format=duration:format_tags',
		'-of',
		'json',
		file
	]);
	const probe = JSON.parse(stdout) as Probe;
	const tags = Object.fromEntries(
		Object.entries(probe.format?.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v])
	);
	const d = Number(probe.format?.duration);
	return { tags, durationSec: Number.isFinite(d) && d > 0 ? d : undefined };
}

/** Extracts the embedded cover to a JPEG; false if there is none. */
export async function extractCover(file: string, output: string): Promise<boolean> {
	try {
		await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0:v:0', '-frames:v', '1', output]);
		return true;
	} catch {
		return false;
	}
}

export async function imageSize(file: string): Promise<{ width: number; height: number } | undefined> {
	const { stdout } = await run('ffprobe', [
		'-v',
		'error',
		'-select_streams',
		'v:0',
		'-show_entries',
		'stream=width,height',
		'-of',
		'json',
		file
	]);
	const s = (JSON.parse(stdout) as Probe).streams?.[0];
	return s?.width && s.height ? { width: s.width, height: s.height } : undefined;
}
