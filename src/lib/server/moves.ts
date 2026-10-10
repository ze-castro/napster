import { stat } from 'node:fs/promises';
import { backupMoves } from './backups';
import { db } from './db';

/** One file napster moved: absolute paths, and when. */
export interface Move {
	from: string;
	to: string;
	at: number;
}

const MAX_MOVES = 10000;

const q = {
	insert: db.query('INSERT INTO moves (from_path, to_path, at) VALUES (?, ?, ?)'),
	prune: db.query('DELETE FROM moves WHERE id <= (SELECT MAX(id) FROM moves) - ?'),
	since: db.query<Move, [number]>('SELECT from_path AS "from", to_path AS "to", at FROM moves WHERE at >= ? ORDER BY id')
};

/** Logs moves, so reviews can find files that moved after they were made. */
export async function recordMoves(moves: Map<string, string>): Promise<void> {
	if (!moves.size) return;
	const at = Date.now();
	db.transaction(() => {
		for (const [from, to] of moves) if (from !== to) q.insert.run(from, to, at);
		q.prune.run(MAX_MOVES);
	})();
}

/**
 * Where a file that was at `path` is now, following every move made after `since`.
 * Uses the move log plus backup records (which also cover moves from before the log existed).
 * Undefined when the trail ends at a file that doesn't exist.
 */
export async function locate(path: string, since: number): Promise<string | undefined> {
	const moves = [...q.since.all(since), ...backupMoves().filter((m) => m.at >= since)].sort((a, b) => a.at - b.at);
	let current = path;
	for (const m of moves) if (m.from === current) current = m.to;
	if (current === path) return undefined;
	return (await stat(current).catch(() => undefined)) ? current : undefined;
}
