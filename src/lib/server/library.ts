import { chown, copyFile, mkdir, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { ExistingFileMode, FileOwner, Settings } from '$lib/settings';
import type { LibraryAlbum } from '$lib/types';
import type { Tags } from './tags';
import { safeSegment } from './text';

export const BACKUP_DIR = '.napster-backups';

/** `{albumArtist}/{album}/{track}. {title}.m4a`, with a disc prefix only on multi-disc releases. */
export function destinationFor(root: string, tags: Tags): string {
	const artistDir = safeSegment(tags.albumArtist ?? tags.artist, 'Unknown Artist');
	const albumDir = safeSegment(tags.album, 'Unknown Album');
	const title = safeSegment(tags.title, 'Untitled');
	let prefix = '';
	if (tags.trackNumber) {
		const n = String(tags.trackNumber).padStart(2, '0');
		prefix = (tags.discCount ?? 1) > 1 ? `${tags.discNumber ?? 1}-${n}. ` : `${n}. `;
	}
	const dest = resolve(root, artistDir, albumDir, `${prefix}${title}.m4a`);
	assertInside(root, dest);
	return dest;
}

/** Guards every path built from metadata or user input against escaping the library. */
export function assertInside(root: string, path: string) {
	if (!resolve(path).startsWith(resolve(root) + sep)) throw new Error('Refusing to touch a path outside the music folder.');
}

export const exists = (p: string) => stat(p).then(() => true, () => false);

export async function libraryRoot(settings: Settings): Promise<{ root: string; owner: FileOwner }> {
	const root = resolve(settings.libraryDir);
	// Never create the library root itself: if it's missing, the mount is wrong.
	const s = await stat(root).catch(() => undefined);
	if (!s?.isDirectory()) throw new Error(`Music folder ${root} does not exist.`);
	return { root, owner: settings.owner ?? { uid: s.uid, gid: s.gid } };
}

export async function setOwner(path: string, owner: FileOwner, warnings: Set<string>) {
	try {
		await chown(path, owner.uid, owner.gid);
	} catch (err) {
		warnings.add(`Could not set file owner (${(err as NodeJS.ErrnoException).code}).`);
	}
}

// All library writes run one at a time so "skip"/"keep both", re-tags and restores can't race.
let chain: Promise<unknown> = Promise.resolve();
export function withLibraryLock<T>(fn: () => Promise<T>): Promise<T> {
	const next = chain.then(fn);
	chain = next.catch(() => undefined);
	return next;
}

export interface Placed {
	path: string; // relative to the library
	skipped: boolean;
}

/** Must be called inside withLibraryLock. */
export async function placeUnlocked(
	src: string,
	dest: string,
	root: string,
	owner: FileOwner,
	mode: ExistingFileMode,
	warnings: Set<string>
): Promise<Placed> {
	if (await exists(dest)) {
		if (mode === 'skip') return { path: relative(root, dest), skipped: true };
		if (mode === 'keep-both') {
			const ext = extname(dest);
			const stem = join(dirname(dest), basename(dest, ext));
			let n = 2;
			while (await exists(`${stem} (${n})${ext}`)) n++;
			dest = `${stem} (${n})${ext}`;
		}
	}

	// Create Artist/ and Album/ one level at a time so only new folders get chowned.
	let dir = root;
	for (const segment of relative(root, dirname(dest)).split(sep)) {
		dir = join(dir, segment);
		if (!(await exists(dir))) {
			await mkdir(dir);
			await setOwner(dir, owner, warnings);
		}
	}

	// Copy + rename: a media server scanning the library never sees a half-written file,
	// and the old inode (possibly hard-linked into a backup) is never modified.
	const part = join(dirname(dest), `.${Date.now()}.napster-part`);
	try {
		await copyFile(src, part);
		await setOwner(part, owner, warnings);
		await rename(part, dest);
	} catch (err) {
		await unlink(part).catch(() => undefined);
		throw err;
	}
	return { path: relative(root, dest), skipped: false };
}

/** Removes `dir` and then its parents while they are empty, stopping at the library root. */
export async function removeEmptyDirs(root: string, dir: string) {
	let current = resolve(dir);
	while (current.startsWith(resolve(root) + sep)) {
		const entries = await readdir(current).catch(() => undefined);
		if (!entries) return;
		// macOS/Windows litter; don't let it keep a folder alive.
		const junk = entries.filter((e) => e === '.DS_Store' || e === 'Thumbs.db');
		if (entries.length !== junk.length) return;
		for (const j of junk) await unlink(join(current, j)).catch(() => undefined);
		await rmdir(current).catch(() => undefined);
		current = dirname(current);
	}
}

const isAudio = (name: string) => /\.(m4a|mp4)$/i.test(name) && !name.startsWith('.');

export async function audioFilesIn(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	return entries
		.filter((e) => e.isFile() && isAudio(e.name))
		.map((e) => join(dir, e.name))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Every folder (1 or 2 levels deep) that contains .m4a files. */
export async function listAlbums(root: string): Promise<LibraryAlbum[]> {
	const out: LibraryAlbum[] = [];
	const visible = async (dir: string) =>
		(await readdir(dir, { withFileTypes: true }).catch(() => [])).filter(
			(e) => e.isDirectory() && !e.name.startsWith('.')
		);

	const check = async (artist: string, album: string) => {
		const rel = artist ? join(artist, album) : album;
		const files = await audioFilesIn(join(root, rel)).catch(() => []);
		if (!files.length) return;
		const first = await stat(files[0]).catch(() => undefined);
		out.push({ path: rel, artist, album, tracks: files.length, version: Math.round(first?.mtimeMs ?? 0) });
	};

	await Promise.all(
		(await visible(root)).map(async (top) => {
			await check('', top.name);
			const subs = await visible(join(root, top.name));
			await Promise.all(subs.map((sub) => check(top.name, sub.name)));
		})
	);
	const key = (a: LibraryAlbum) => `${a.artist || a.album}\u0000${a.album}`.toLowerCase();
	return out.sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true }));
}

/** Validates a library-relative folder from the client. */
export async function albumFolder(root: string, rel: string): Promise<string> {
	const abs = resolve(root, rel);
	assertInside(root, abs);
	if (relative(root, abs).split(sep).some((s) => s.startsWith('.'))) throw new Error('Hidden folders are off limits.');
	const s = await stat(abs).catch(() => undefined);
	if (!s?.isDirectory()) throw new Error('Folder not found.');
	return abs;
}
