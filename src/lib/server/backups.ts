import { chown, copyFile, link, mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import type { BackupSummary } from '$lib/types';
import { BACKUP_DIR, assertInside, exists, removeEmptyDirs, withLibraryLock } from './library';
import { db } from './db';

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

const q = {
	summaries: db.query<BackupSummary, []>(
		`SELECT b.id, b.created_at AS createdAt, b.label, COUNT(f.backup_id) AS files
		 FROM backups b LEFT JOIN backup_files f ON f.backup_id = b.id
		 GROUP BY b.id ORDER BY b.created_at DESC`
	),
	one: db.query<Omit<Backup, 'files'>, [string]>(
		'SELECT id, created_at AS createdAt, library_dir AS libraryDir, label FROM backups WHERE id = ?'
	),
	all: db.query<Pick<Backup, 'id' | 'libraryDir'>, []>('SELECT id, library_dir AS libraryDir FROM backups'),
	files: db.query<BackupFile, [string]>(
		'SELECT original, current, stored FROM backup_files WHERE backup_id = ? ORDER BY position'
	),
	insert: db.query('INSERT INTO backups (id, created_at, library_dir, label) VALUES (?, ?, ?, ?)'),
	insertFile: db.query('INSERT INTO backup_files (backup_id, position, original, current, stored) VALUES (?, ?, ?, ?, ?)'),
	setCurrent: db.query('UPDATE backup_files SET current = ? WHERE backup_id = ? AND original = ?'),
	delete: db.query('DELETE FROM backups WHERE id = ?'), // its files go with it (ON DELETE CASCADE)
	deleteAll: db.query('DELETE FROM backups'),
	moves: db.query<{ libraryDir: string; original: string; current: string; at: number }, []>(
		`SELECT b.library_dir AS libraryDir, f.original, f.current, b.created_at AS at
		 FROM backup_files f JOIN backups b ON b.id = f.backup_id
		 WHERE f.current IS NOT NULL AND f.current <> f.original`
	)
};

function getBackup(id: string): Backup | undefined {
	const row = q.one.get(id);
	return row ? { ...row, files: q.files.all(id) } : undefined;
}

export async function listBackups(): Promise<BackupSummary[]> {
	return q.summaries.all();
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
	db.transaction(() => {
		q.insert.run(id, Date.now(), libraryDir, label);
		for (const [i, f] of entries.entries()) q.insertFile.run(id, i, f.original, f.current, f.stored);
	})();
	return id;
}

export async function recordCurrentPaths(id: string, current: Map<string, string>): Promise<void> {
	db.transaction(() => {
		for (const f of q.files.all(id)) q.setCurrent.run(current.get(f.original) ?? null, id, f.original);
	})();
}

/**
 * Puts every original file back where it was and removes the re-tagged versions.
 * Returns the files it moved back (current path → original path).
 */
export function restoreBackup(id: string): Promise<Map<string, string>> {
	return withLibraryLock(async () => {
		const moves = new Map<string, string>();
		const backup = getBackup(id);
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
		q.delete.run(id);
		return moves;
	});
}

/** Moves recorded in backup records (original → where the re-tag put it), for finding files later. */
export function backupMoves(): { from: string; to: string; at: number }[] {
	return q.moves
		.all()
		.map((m) => ({ from: resolve(m.libraryDir, m.original), to: resolve(m.libraryDir, m.current), at: m.at }));
}

export function deleteBackup(id: string): Promise<void> {
	return withLibraryLock(async () => {
		const backup = q.one.get(id);
		if (!backup) throw new Error('Backup not found.');
		await rm(folderOf(backup), { recursive: true, force: true });
		q.delete.run(id);
	});
}

/** Removes every backup; the current files in the library are not touched. */
export function deleteAllBackups(): Promise<number> {
	return withLibraryLock(async () => {
		const list = q.all.all();
		for (const b of list) await rm(folderOf(b), { recursive: true, force: true });
		q.deleteAll.run();
		return list.length;
	});
}
