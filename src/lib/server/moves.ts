import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { backupMoves } from './backups';
import { config } from './config';
import { readJson, writeJson } from './store';

/** One file napster moved: absolute paths, and when. */
export interface Move {
	from: string;
	to: string;
	at: number;
}

const FILE = join(config.dataDir, 'moves.json');
const MAX_MOVES = 10000;

let chain: Promise<unknown> = Promise.resolve();

/** Appends moves to data/moves.json, so reviews can find files that moved after they were made. */
export function recordMoves(moves: Map<string, string>): Promise<void> {
	if (!moves.size) return Promise.resolve();
	const next = chain.then(async () => {
		const list = (await readJson<Move[]>(FILE)) ?? [];
		const at = Date.now();
		for (const [from, to] of moves) if (from !== to) list.push({ from, to, at });
		await writeJson(FILE, list.slice(-MAX_MOVES));
	});
	chain = next.catch(() => undefined);
	return next;
}

/**
 * Where a file that was at `path` is now, following every move made after `since`.
 * Uses the move log plus backup records (which also cover moves from before the log existed).
 * Undefined when the trail ends at a file that doesn't exist.
 */
export async function locate(path: string, since: number): Promise<string | undefined> {
	await chain;
	const moves = [...((await readJson<Move[]>(FILE)) ?? []), ...(await backupMoves())]
		.filter((m) => m.at >= since)
		.sort((a, b) => a.at - b.at);
	let current = path;
	for (const m of moves) if (m.from === current) current = m.to;
	if (current === path) return undefined;
	return (await stat(current).catch(() => undefined)) ? current : undefined;
}
