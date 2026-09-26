import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Reads a JSON file; undefined if missing or unparseable. */
export async function readJson<T>(path: string): Promise<T | undefined> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch {
		return undefined;
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		console.error(`[napster] ${path} is not valid JSON; using defaults`);
		return undefined;
	}
}

/** Write-then-rename so a crash never leaves a half-written file. */
export async function writeJson(path: string, data: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(tmp, JSON.stringify(data, null, '\t') + '\n');
	await rename(tmp, path);
}
