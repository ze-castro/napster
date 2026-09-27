import { chown, copyFile, link, mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import type { BackupSummary } from '$lib/types';
import { config } from './config';
import { BACKUP_DIR, assertInside, exists, removeEmptyDirs, withLibraryLock } from './library';
import { readJson, writeJson } from './store';

interface BackupFile {
	original: string; // library-relative path before the re-tag
	current: string | null; // library-relative path after it
	stored: string; // file name inside the backup folder
}

interface Backup {
	id: string;
	createdAt: number;
	libraryDir: string;
	label: string;
	files: BackupFile[];
}

const FILE = join(config.dataDir, 'backups.json');

// backups.json edits are serialized too.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: Backup[]) => Promise<T> | T): Promise<T> {
	const next = chain.then(async () => {
		const list = (await readJson<Backup[]>(FILE)) ?? [];
		const result = await fn(list);
		await writeJson(FILE, list);
		return result;
	});
	chain = next.catch(() => undefined);
	return next;
}

export async function listBackups(): Promise<BackupSummary[]> {
	const list = (await readJson<Backup[]>(FILE)) ?? [];
	return list
		.map((b) => ({ id: b.id, createdAt: b.createdAt, label: b.label, files: b.files.length }))
		.sort((a, b) => b.createdAt - a.createdAt);
}

const folderOf = (b: Pick<Backup, 'libraryDir' | 'id'>) => join(b.libraryDir, BACKUP_DIR, b.id);

/** Hard link when possible (instant, no extra space); copy if the filesystem refuses. */
async function linkOrCopy(src: string, dest: string) {
	try {
		await link(src, dest);
	} catch {
		await copyFile(src, dest);
	}
}

/**
 * Snapshots files before a re-tag. Re-tags write new files and rename them into place,
 * so the original inodes stay untouched and the snapshot is byte-for-byte exact.
 * Must be called inside withLibraryLock.
 */
export async function createBackupUnlocked(libraryDir: string, label: string, files: string[]): Promise<string> {
	const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
	const base = join(libraryDir, BACKUP_DIR);
	const folder = join(base, id);
	await mkdir(folder, { recursive: true });
	// An empty .ndignore makes Navidrome skip the whole backup folder.
	await writeFile(join(base, '.ndignore'), '');

	const entries: BackupFile[] = [];
	for (const [i, abs] of files.entries()) {
		const stored = `${String(i + 1).padStart(3, '0')}.m4a`;
		await linkOrCopy(abs, join(folder, stored));
		entries.push({ original: relative(libraryDir, abs), current: null, stored });
	}
	await mutate((list) => {
		list.push({ id, createdAt: Date.now(), libraryDir, label, files: entries });
	});
	return id;
}

export function recordCurrentPaths(id: string, current: Map<string, string>) {
	return mutate((list) => {
		const b = list.find((x) => x.id === id);
		if (!b) return;
		for (const f of b.files) f.current = current.get(f.original) ?? null;
	});
}

/** Puts every original file back where it was and removes the re-tagged versions. */
/** Restores a backup; returns the files it moved back (current path → original path). */
export function restoreBackup(id: string): Promise<Map<string, string>> {
	return withLibraryLock(async () => {
		const moves = new Map<string, string>();
		const backup = ((await readJson<Backup[]>(FILE)) ?? []).find((b) => b.id === id);
		if (!backup) throw new Error('Backup not found.');
		const root = backup.libraryDir;
		const folder = folderOf(backup);

		for (const f of backup.files) {
			const stored = join(folder, f.stored);
			if (!(await exists(stored))) throw new Error(`Backup file ${f.stored} is missing; nothing was changed.`);
		}

		const touchedDirs = new Set<string>();
		for (const f of backup.files) {
			const original = resolve(root, f.original);
			assertInside(root, original);
			if (f.current && f.current !== f.original) {
				const current = resolve(root, f.current);
				assertInside(root, current);
				await unlink(current).catch(() => undefined);
				touchedDirs.add(dirname(current));
				moves.set(current, original);
			}
			const stored = join(folder, f.stored);
			if (!(await exists(dirname(original)))) {
				// Folders recreated by the restore get the same owner as the file.
				const owner = await stat(stored);
				await mkdir(dirname(original), { recursive: true });
				await chown(dirname(original), owner.uid, owner.gid).catch(() => undefined);
			}
			const tmp = join(dirname(original), `.${Date.now()}.napster-restore`);
			await linkOrCopy(stored, tmp);
			await rename(tmp, original);
		}
		for (const dir of touchedDirs) await removeEmptyDirs(root, dir);

		await rm(folder, { recursive: true, force: true });
		await mutate((list) => {
			const i = list.findIndex((b) => b.id === id);
			if (i >= 0) list.splice(i, 1);
		});
		return moves;
	});
}

/** Moves recorded in backup records (original → where the re-tag put it), for finding files later. */
export async function backupMoves(): Promise<{ from: string; to: string; at: number }[]> {
	const out: { from: string; to: string; at: number }[] = [];
	for (const b of (await readJson<Backup[]>(FILE)) ?? []) {
		for (const f of b.files) {
			if (f.current && f.current !== f.original) {
				out.push({ from: resolve(b.libraryDir, f.original), to: resolve(b.libraryDir, f.current), at: b.createdAt });
			}
		}
	}
	return out;
}

export function deleteBackup(id: string): Promise<void> {
	return withLibraryLock(async () => {
		const backup = ((await readJson<Backup[]>(FILE)) ?? []).find((b) => b.id === id);
		if (!backup) throw new Error('Backup not found.');
		await rm(folderOf(backup), { recursive: true, force: true });
		await mutate((list) => {
			const i = list.findIndex((b) => b.id === id);
			if (i >= 0) list.splice(i, 1);
		});
	});
}

/** Removes every backup; the current files in the library are not touched. */
export function deleteAllBackups(): Promise<number> {
	return withLibraryLock(async () => {
		const list = (await readJson<Backup[]>(FILE)) ?? [];
		for (const b of list) await rm(folderOf(b), { recursive: true, force: true });
		await mutate((l) => {
			l.length = 0;
		});
		return list.length;
	});
}
