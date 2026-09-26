import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtSource } from '$lib/types';
import { findDeezerCover } from './deezer';
import { getImage } from './http';
import { run } from './proc';
import { imageSize } from './tagging';

export interface ArtCandidate {
	source: ArtSource;
	/** Lazily fetches the image to a local path; undefined if unavailable. */
	fetch: () => Promise<string | undefined>;
}

function remote(source: ArtSource, dir: string, name: string, url: () => Promise<string | undefined>): ArtCandidate {
	return {
		source,
		fetch: async () => {
			const u = await url();
			if (!u) return undefined;
			const img = await getImage(u);
			if (!img) return undefined;
			const path = join(dir, `${name}.src`);
			await writeFile(path, img);
			return path;
		}
	};
}

/** Deezer first (always), then local fallbacks: the YouTube thumbnail or the cover already embedded. */
export function artCandidates(opts: {
	dir: string;
	size: number;
	artist?: string;
	album?: string;
	title?: string;
	fallbacks?: { source: ArtSource; path: string }[];
}): ArtCandidate[] {
	const list: ArtCandidate[] = [];
	if (opts.artist) {
		const { artist, album, title, size } = opts;
		list.push(remote('deezer', opts.dir, 'deezer', () => findDeezerCover({ artist, album, title, size })));
	}
	for (const f of opts.fallbacks ?? []) {
		list.push({ source: f.source, fetch: async () => f.path });
	}
	return list;
}

/**
 * Center-crops to a square, caps at `size` px (never upscales) and re-encodes as JPEG
 * (most players handle JPEG in MP4 `covr` best). Handles letterboxed 16:9 YouTube thumbnails.
 */
export async function squareJpeg(input: string, output: string, size: number): Promise<void> {
	await run('ffmpeg', [
		'-hide_banner',
		'-loglevel',
		'error',
		'-y',
		'-i',
		input,
		'-vf',
		`crop='min(iw,ih)':'min(iw,ih)',scale='min(${size},iw)':'min(${size},ih)':flags=lanczos,format=yuvj420p`,
		'-frames:v',
		'1',
		'-q:v',
		'2',
		output
	]);
}

/** One cover per album: first candidate that yields a usable square image wins. */
export async function prepareCover(
	candidates: ArtCandidate[],
	output: string,
	size: number
): Promise<ArtSource | undefined> {
	for (const c of candidates) {
		try {
			const src = await c.fetch();
			if (!src) continue;
			await squareJpeg(src, output, size);
			const dims = await imageSize(output);
			if (dims && dims.width === dims.height && dims.width >= 300) return c.source;
		} catch {
			// bad image or network error: try the next source
		}
	}
	return undefined;
}
