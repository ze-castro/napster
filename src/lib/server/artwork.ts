import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtSource } from '$lib/types';
import { getImage } from './http';
import { run } from './proc';
import { imageSize } from './tagging';

export interface ArtCandidate {
	source: ArtSource;
	/** Lazily provides a local image path; undefined if unavailable. */
	fetch: () => Promise<string | undefined>;
}

/** An image from a URL (Deezer, or one pasted by the user), downloaded when needed. */
export function remoteCover(source: ArtSource, dir: string, url: string | undefined): ArtCandidate {
	return {
		source,
		fetch: async () => {
			if (!url || !/^https?:\/\//i.test(url)) return undefined;
			const img = await getImage(url);
			if (!img) return undefined;
			const path = join(dir, `${source}.src`);
			await writeFile(path, img);
			return path;
		}
	};
}

/** An image already on disk: YouTube thumbnail, embedded cover, or an upload. */
export const localCover = (source: ArtSource, path: string): ArtCandidate => ({ source, fetch: async () => path });

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

/** One cover per album: the first candidate that yields a usable square image wins. */
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
			if (dims && dims.width === dims.height && dims.width >= 150) return c.source;
		} catch {
			// bad image or network error: try the next source
		}
	}
	return undefined;
}
