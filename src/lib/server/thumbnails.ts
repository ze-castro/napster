import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config';
import { audioFilesIn } from './library';
import { run } from './proc';

const DIR = join(config.dataDir, 'thumbs');
const SIZE = 160; // shown at 40–80 px; 2× for sharp screens

// A library page asks for dozens of covers at once; keep ffmpeg processes in check.
let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
	if (active >= 4) await new Promise<void>((r) => waiting.push(r));
	active++;
	try {
		return await fn();
	} finally {
		active--;
		waiting.shift()?.();
	}
}

/**
 * Small JPEG of the folder's cover (from its first song), cached in data/thumbs.
 * The cache key includes the file's mtime, so re-tagged albums get a fresh thumbnail.
 */
export async function folderThumbnail(folderAbs: string): Promise<Buffer | undefined> {
	const [first] = await audioFilesIn(folderAbs);
	if (!first) return undefined;
	const s = await stat(first);
	const key = createHash('sha1').update(`${first}\0${s.mtimeMs}\0${s.size}`).digest('hex');
	const file = join(DIR, `${key}.jpg`);

	const cached = await readFile(file).catch(() => undefined);
	if (cached) return cached.length ? cached : undefined; // empty file = "has no cover"

	return limited(async () => {
		await mkdir(DIR, { recursive: true });
		const tmp = `${file}.${process.pid}.tmp.jpg`;
		try {
			await run('ffmpeg', [
				'-hide_banner', '-loglevel', 'error', '-y',
				'-i', first,
				'-map', '0:v:0', '-frames:v', '1',
				'-vf', `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=increase,crop=${SIZE}:${SIZE}`,
				'-q:v', '4',
				tmp
			]);
			await rename(tmp, file);
			return await readFile(file);
		} catch {
			// Remember "no cover" so we don't run ffmpeg on every page load.
			await writeFile(file, '').catch(() => undefined);
			return undefined;
		}
	});
}
