import { building } from '$app/environment';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config';

/**
 * Everything napster remembers lives in one SQLite file, data/napster.db: settings, history,
 * open reviews, the backup list and the move log. Cookies, pending audio and cover thumbnails
 * stay plain files next to it.
 */

const SCHEMA_VERSION = 1;

const SCHEMA = `
	CREATE TABLE settings (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL -- JSON
	) WITHOUT ROWID;

	-- A job is always read and sent to the browser whole, so its tracks stay in one JSON
	-- document; the columns are what gets filtered and sorted.
	CREATE TABLE jobs (
		id         TEXT PRIMARY KEY,
		created_at INTEGER NOT NULL,
		kind       TEXT NOT NULL,
		status     TEXT NOT NULL,
		data       TEXT NOT NULL
	) WITHOUT ROWID;
	CREATE INDEX jobs_created_at ON jobs (created_at);

	-- The columns are the list view (read on every live update); data is the full review.
	CREATE TABLE reviews (
		id         TEXT PRIMARY KEY,
		job_id     TEXT NOT NULL,
		kind       TEXT NOT NULL,
		title      TEXT NOT NULL,
		reason     TEXT NOT NULL,
		note       TEXT,
		songs      INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		data       TEXT NOT NULL
	) WITHOUT ROWID;

	CREATE TABLE backups (
		id          TEXT PRIMARY KEY,
		created_at  INTEGER NOT NULL,
		library_dir TEXT NOT NULL,
		label       TEXT NOT NULL
	) WITHOUT ROWID;

	CREATE TABLE backup_files (
		backup_id TEXT NOT NULL REFERENCES backups (id) ON DELETE CASCADE,
		position  INTEGER NOT NULL,
		original  TEXT NOT NULL, -- library-relative path before the re-tag
		current   TEXT,          -- library-relative path after it
		stored    TEXT NOT NULL, -- file name inside the backup folder
		PRIMARY KEY (backup_id, position)
	) WITHOUT ROWID;

	CREATE TABLE moves (
		id        INTEGER PRIMARY KEY AUTOINCREMENT,
		from_path TEXT NOT NULL,
		to_path   TEXT NOT NULL,
		at        INTEGER NOT NULL
	);
	CREATE INDEX moves_at ON moves (at);
`;

/** The JSON files older versions kept in the data folder. */
const LEGACY = {
	settings: 'settings.json',
	jobs: 'history.json',
	reviews: 'reviews.json',
	backups: 'backups.json',
	moves: 'moves.json'
} as const;

function readLegacy<T>(name: string): T | undefined {
	const path = join(config.dataDir, name);
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as T;
	} catch {
		console.error(`[napster] ${path} is not valid JSON; it was not imported`);
		return undefined;
	}
}

const list = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);

/** One-time import of the old JSON files, so an upgrade keeps history, reviews and backups. */
function importLegacy(db: Database): string[] {
	const imported: string[] = [];

	const settings = readLegacy<Record<string, unknown>>(LEGACY.settings);
	if (settings && typeof settings === 'object') {
		const put = db.query('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
		for (const [key, value] of Object.entries(settings)) put.run(key, JSON.stringify(value));
		imported.push(LEGACY.settings);
	}

	const jobs = readLegacy<{ id: string; createdAt: number; kind: string; status: string }[]>(LEGACY.jobs);
	if (jobs) {
		const put = db.query('INSERT OR REPLACE INTO jobs (id, created_at, kind, status, data) VALUES (?, ?, ?, ?, ?)');
		for (const j of list(jobs)) put.run(j.id, j.createdAt, j.kind, j.status, JSON.stringify(j));
		imported.push(LEGACY.jobs);
	}

	const reviews = readLegacy<
		{
			id: string;
			jobId: string;
			kind: string;
			title: string;
			reason: string;
			note?: string;
			createdAt: number;
			files?: unknown[];
		}[]
	>(LEGACY.reviews);
	if (reviews) {
		const put = db.query(
			'INSERT OR REPLACE INTO reviews (id, job_id, kind, title, reason, note, songs, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
		);
		for (const r of list(reviews)) {
			put.run(r.id, r.jobId, r.kind, r.title, r.reason, r.note ?? null, list(r.files).length, r.createdAt, JSON.stringify(r));
		}
		imported.push(LEGACY.reviews);
	}

	const backups = readLegacy<
		{
			id: string;
			createdAt: number;
			libraryDir: string;
			label: string;
			files?: { original: string; current: string | null; stored: string }[];
		}[]
	>(LEGACY.backups);
	if (backups) {
		const put = db.query('INSERT OR REPLACE INTO backups (id, created_at, library_dir, label) VALUES (?, ?, ?, ?)');
		const putFile = db.query(
			'INSERT OR REPLACE INTO backup_files (backup_id, position, original, current, stored) VALUES (?, ?, ?, ?, ?)'
		);
		for (const b of list(backups)) {
			put.run(b.id, b.createdAt, b.libraryDir, b.label);
			for (const [i, f] of list(b.files).entries()) putFile.run(b.id, i, f.original, f.current ?? null, f.stored);
		}
		imported.push(LEGACY.backups);
	}

	const moves = readLegacy<{ from: string; to: string; at: number }[]>(LEGACY.moves);
	if (moves) {
		const put = db.query('INSERT INTO moves (from_path, to_path, at) VALUES (?, ?, ?)');
		for (const m of list(moves)) put.run(m.from, m.to, m.at);
		imported.push(LEGACY.moves);
	}

	return imported;
}

function open(): Database {
	// `vite build` imports the server code to analyse it; that must not touch the data folder.
	if (building) {
		const scratch = new Database(':memory:', { strict: true });
		scratch.run(SCHEMA);
		return scratch;
	}

	mkdirSync(config.dataDir, { recursive: true });
	const db = new Database(join(config.dataDir, 'napster.db'), { create: true, strict: true });
	// WAL: readers never wait for the writer, and a crash can't leave a half-written database.
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA synchronous = NORMAL');
	db.run('PRAGMA foreign_keys = ON');
	db.run('PRAGMA busy_timeout = 5000');

	const { user_version: version } = db.query('PRAGMA user_version').get() as { user_version: number };
	if (version < SCHEMA_VERSION) {
		let imported: string[] = [];
		db.transaction(() => {
			db.run(SCHEMA);
			imported = importLegacy(db);
			db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		})();
		// Kept, not deleted: the import can be checked, and an older version can still be run.
		for (const name of imported) {
			const path = join(config.dataDir, name);
			try {
				renameSync(path, `${path}.migrated`);
			} catch (err) {
				console.error(`[napster] could not rename ${path}`, err);
			}
		}
		if (imported.length) console.log(`[napster] imported ${imported.join(', ')} into napster.db`);
	}
	return db;
}

// Vite re-evaluates this module on edits in dev; keep one connection per process.
const cache = globalThis as { __napsterDb?: Database };
export const db: Database = (cache.__napsterDb ??= open());
