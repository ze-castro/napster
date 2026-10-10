import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { ArtSource, ReviewDetail, ReviewSummary } from '$lib/types';
import { config } from './config';
import { locate } from './moves';
import { extractCover, probeFile } from './tagging';
import type { SourceTrack } from './match';
import { db } from './db';

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

/** Downloaded audio waiting for a review lives here, so it survives restarts. */
export const pendingDir = (id: string) => join(config.dataDir, 'pending', id);

const q = {
	all: db.query<{ data: string }, []>('SELECT data FROM reviews ORDER BY created_at'),
	one: db.query<{ data: string }, [string]>('SELECT data FROM reviews WHERE id = ?'),
	summaries: db.query<ReviewSummary, []>(
		`SELECT id, job_id AS jobId, kind, title, reason, note, songs, created_at AS createdAt
		 FROM reviews ORDER BY created_at DESC`
	),
	upsert: db.query(
		`INSERT INTO reviews (id, job_id, kind, title, reason, note, songs, created_at, data)
		 VALUES ($id, $jobId, $kind, $title, $reason, $note, $songs, $createdAt, $data)
		 ON CONFLICT (id) DO UPDATE SET
			job_id = excluded.job_id, kind = excluded.kind, title = excluded.title, reason = excluded.reason,
			note = excluded.note, songs = excluded.songs, created_at = excluded.created_at, data = excluded.data`
	),
	delete: db.query('DELETE FROM reviews WHERE id = ?')
};

const parse = (row: { data: string }) => JSON.parse(row.data) as Review;

function save(r: Review) {
	q.upsert.run({
		id: r.id,
		jobId: r.jobId,
		kind: r.kind,
		title: r.title,
		reason: r.reason,
		note: r.note ?? null,
		songs: r.files.length,
		createdAt: r.createdAt,
		data: JSON.stringify(r)
	});
}

export async function allReviews(): Promise<Review[]> {
	return q.all.all().map(parse);
}

export async function getReview(id: string): Promise<Review | undefined> {
	const row = q.one.get(id);
	return row ? parse(row) : undefined;
}

/** The "Needs input" list, newest first; cheap enough to read on every live update. */
export function reviewSummaries(): ReviewSummary[] {
	return q.summaries.all().map((r) => ({ ...r, note: r.note ?? undefined }));
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

export async function addReview(r: Review): Promise<void> {
	save(r);
}

export async function removeReview(id: string): Promise<void> {
	q.delete.run(id);
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
	// Read the moved files' tags first, so the reviews are rewritten in one transaction.
	const affected = new Set<string>();
	for (const r of await allReviews()) {
		if (r.kind === 'download') continue;
		for (const f of r.files) if (moves.has(f.path)) affected.add(moves.get(f.path)!);
	}
	if (!affected.size) return;
	const tags = new Map<string, Record<string, string> | undefined>();
	for (const to of affected) tags.set(to, (await probeFile(to).catch(() => undefined))?.tags);

	db.transaction(() => {
		for (const r of q.all.all().map(parse)) {
			if (r.kind === 'download') continue;
			let touched = false;
			for (const f of r.files) {
				const to = moves.get(f.path);
				if (!to) continue;
				f.path = to;
				f.originalTags = tags.get(to) ?? f.originalTags;
				touched = true;
			}
			if (touched) save(r);
		}
	})();
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
