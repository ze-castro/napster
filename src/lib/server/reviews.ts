import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { ArtSource, ReviewDetail, ReviewSummary } from '$lib/types';
import { config } from './config';
import { locate } from './moves';
import { extractCover, probeFile } from './tagging';
import type { SourceTrack } from './match';
import { readJson, writeJson } from './store';

/** A group of songs waiting for the user: no confident Deezer match, or "Edit tags". */
export interface Review extends ReviewDetail {
	/** Cleaned source data, used to map a picked Deezer album onto these songs. */
	sources: SourceTrack[];
	files: {
		key: string;
		/** Downloads: the pending audio in data/pending. Re-tags: the file in the library. */
		path: string;
		art?: { source: ArtSource; path: string };
		/** Re-tags only: the tags the file had, for the change list. */
		originalTags?: Record<string, string>;
	}[];
	folder?: string;
}

const FILE = join(config.dataDir, 'reviews.json');

/** Downloaded audio waiting for a review lives here, so it survives restarts. */
export const pendingDir = (id: string) => join(config.dataDir, 'pending', id);

let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (list: Review[]) => T | Promise<T>): Promise<T> {
	const next = chain.then(async () => {
		const list = (await readJson<Review[]>(FILE)) ?? [];
		const result = await fn(list);
		await writeJson(FILE, list);
		return result;
	});
	chain = next.catch(() => undefined);
	return next;
}

export async function allReviews(): Promise<Review[]> {
	await chain; // don't read while a write is in flight
	return (await readJson<Review[]>(FILE)) ?? [];
}

export async function getReview(id: string): Promise<Review | undefined> {
	return (await allReviews()).find((r) => r.id === id);
}

export function summary(r: Review): ReviewSummary {
	return {
		id: r.id,
		jobId: r.jobId,
		kind: r.kind,
		title: r.title,
		reason: r.reason,
		note: r.note,
		songs: r.files.length,
		createdAt: r.createdAt
	};
}

/** What the browser gets: everything except server paths, plus files that have gone missing. */
export async function detail(r: Review): Promise<ReviewDetail> {
	const { sources: _s, files: _f, folder: _d, ...rest } = r;
	const missing = await missingFiles(r);
	return missing.length ? { ...rest, missing } : rest;
}

/** File names of a review's songs that are no longer where the review expects them. */
export async function missingFiles(r: Review): Promise<string[]> {
	const gone = await Promise.all(r.files.map(async (f) => !(await stat(f.path).catch(() => undefined))));
	return r.files.filter((_, i) => gone[i]).map((f) => basename(f.path));
}

/** Library files that open re-tag/edit reviews are waiting on. */
export async function pathsInReviews(): Promise<Set<string>> {
	const paths = new Set<string>();
	for (const r of await allReviews()) {
		if (r.kind !== 'download') for (const f of r.files) paths.add(f.path);
	}
	return paths;
}

export function addReview(r: Review): Promise<void> {
	return mutate((list) => {
		list.push(r);
	});
}

export async function removeReview(id: string): Promise<void> {
	await mutate((list) => {
		const i = list.findIndex((r) => r.id === id);
		if (i >= 0) list.splice(i, 1);
	});
	await rm(pendingDir(id), { recursive: true, force: true });
}

export async function ensurePendingDir(id: string): Promise<string> {
	const dir = pendingDir(id);
	await mkdir(dir, { recursive: true });
	return dir;
}

/** An open re-tag/edit review waiting on songs in this library folder, if any. */
export async function reviewForFolder(root: string, folder: string): Promise<Review | undefined> {
	return (await allReviews()).find(
		(r) => r.kind !== 'download' && r.files.some((f) => relative(root, dirname(f.path)) === folder)
	);
}

/**
 * Points open re-tag reviews at files that just moved (a re-tag, a saved review, an Undo),
 * and refreshes their "before" tags, so they keep working instead of going stale.
 */
export async function relinkPaths(moves: Map<string, string>): Promise<void> {
	if (!moves.size) return;
	await mutate(async (list) => {
		for (const r of list) {
			if (r.kind === 'download') continue;
			for (const f of r.files) {
				const to = moves.get(f.path);
				if (!to) continue;
				f.path = to;
				f.originalTags = (await probeFile(to).catch(() => undefined))?.tags ?? f.originalTags;
			}
		}
	});
}

/**
 * Repairs a review whose files moved before moves were tracked live: follows the move log and
 * backup records from the review's creation onwards. Returns the (possibly updated) review.
 */
export async function healReview(id: string): Promise<Review | undefined> {
	const review = await getReview(id);
	if (!review || review.kind === 'download') return review;
	const found = new Map<string, string>();
	for (const f of review.files) {
		if (await stat(f.path).catch(() => undefined)) continue;
		const now = await locate(f.path, review.createdAt);
		if (now) found.set(f.path, now);
	}
	if (!found.size) return review;
	await relinkPaths(found);
	return getReview(id);
}

/**
 * The review's "current cover" as a local image: the saved thumbnail/cover, or, when that image
 * is gone (a review repaired after its files moved), the cover embedded in the song file itself.
 */
export async function currentCoverPath(r: Review): Promise<string | undefined> {
	for (const f of r.files) {
		if (f.art && (await stat(f.art.path).catch(() => undefined))) return f.art.path;
	}
	if (r.kind === 'download') return undefined;
	const dir = await ensurePendingDir(r.id);
	for (const [i, f] of r.files.entries()) {
		const out = join(dir, `${i}-art.jpg`);
		if (await extractCover(f.path, out)) return out;
	}
	return undefined;
}
