import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobState, ResolveInput, ReviewSummary } from '$lib/types';
import { config } from './config';
import { importFromBrowser } from './cookies';
import { albumFolder, libraryRoot } from './library';
import {
	applyReview,
	DISCARDED,
	discardReviewTracks,
	runDownload,
	runRetag,
	settle,
	type Ctx,
	type RetagMode,
	type Slot
} from './pipeline';
import { db } from './db';
import { getReview, healReview, removeReview, reviewSummaries } from './reviews';
import { readSettings } from './settings';
import { DownloadError, explain, parseInput, resolveUrl, type ResolvedEntry } from './ytdlp';

const MAX_JOBS = 50;
/** Live state: every job is in memory, and SQLite holds the copy that survives a restart. */
const jobs = new Map<string, JobState>();
const bus = new EventTarget();

const SETTLED = new Set(['done', 'skipped', 'failed', 'needs-input']);

const q = {
	all: db.query<{ data: string }, []>('SELECT data FROM jobs ORDER BY created_at DESC'),
	upsert: db.query(
		`INSERT INTO jobs (id, created_at, kind, status, data) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (id) DO UPDATE SET status = excluded.status, data = excluded.data`
	),
	delete: db.query('DELETE FROM jobs WHERE id = ?')
};

// ---------------------------------------------------------------- change notifications

// Coalesce progress spam into at most ~5 UI updates per second, and one write per second
// that only touches the jobs that changed.
let notifyPending = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const dirty = new Set<string>();

function flush() {
	clearTimeout(persistTimer);
	persistTimer = undefined;
	if (!dirty.size) return;
	try {
		db.transaction(() => {
			for (const id of dirty) {
				const job = jobs.get(id);
				if (job) q.upsert.run(job.id, job.createdAt, job.kind, job.status, JSON.stringify(job));
			}
		})();
		dirty.clear();
	} catch (err) {
		console.error('[napster] saving history failed', err);
	}
}

// adapter-node emits this on SIGTERM/SIGINT: don't lose the last second of changes.
process.on('sveltekit:shutdown', flush);

/** Call after changing a job (or with no job when only the reviews changed). */
function changed(job?: JobState) {
	if (job) dirty.add(job.id);
	if (!notifyPending) {
		notifyPending = true;
		setTimeout(() => {
			notifyPending = false;
			bus.dispatchEvent(new Event('change'));
		}, 200);
	}
	if (dirty.size) persistTimer ??= setTimeout(flush, 1000);
}

function forget(id: string) {
	jobs.delete(id);
	dirty.delete(id);
	q.delete.run(id);
}

export function subscribe(cb: () => void): () => void {
	bus.addEventListener('change', cb);
	return () => bus.removeEventListener('change', cb);
}

export function listJobs(): JobState[] {
	return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Everything the pages show live. */
export function snapshot(): { jobs: JobState[]; reviews: ReviewSummary[] } {
	return { jobs: listJobs(), reviews: reviewSummaries() };
}

/**
 * History from before errors were explained holds yt-dlp's raw output as the error.
 * Keeps that as the detail and puts a readable sentence in front. True if anything changed.
 */
function tidyLegacyErrors(job: JobState): boolean {
	let touched = false;
	for (const item of [job, ...job.tracks]) {
		if (item.error?.startsWith('yt-dlp exited with') && !item.errorDetail) {
			item.errorDetail = item.error;
			item.error = explain(item.error, false);
			touched = true;
		}
	}
	// Failed links used to keep the URL as their title.
	if (job.url && job.title === job.url) {
		job.title = '';
		touched = true;
	}
	return touched;
}

/** Loads history once; anything that was mid-flight when the server stopped is marked failed. */
export const ready: Promise<void> = (async () => {
	for (const row of q.all.all()) {
		const job = JSON.parse(row.data) as JobState;
		let interrupted = tidyLegacyErrors(job);
		for (const t of job.tracks) {
			if (!SETTLED.has(t.status)) {
				t.status = 'failed';
				t.error ??= 'Interrupted by a restart.';
				interrupted = true;
			}
		}
		if (job.status === 'resolving' || job.status === 'running') {
			if (!job.tracks.length) job.error ??= 'Interrupted by a restart.';
			settle(job);
			if (!job.tracks.length) job.status = 'failed';
			interrupted = true;
		}
		jobs.set(job.id, job);
		if (interrupted) dirty.add(job.id);
	}
	flush();
})();

// ---------------------------------------------------------------- concurrency

// Global limit so a 100-track playlist doesn't spawn 100 yt-dlp processes.
// The limit follows the latest settings; raising it starts waiting tracks immediately.
let limit = 3;
let active = 0;
const waiters: (() => void)[] = [];

function pump() {
	while (active < limit && waiters.length) {
		active++;
		waiters.shift()!();
	}
}

const slot: Slot = async (fn) => {
	await new Promise<void>((r) => {
		waiters.push(r);
		pump();
	});
	try {
		return await fn();
	} finally {
		active--;
		pump();
	}
};

// ---------------------------------------------------------------- jobs

function prune() {
	const finished = listJobs().filter((j) => j.status === 'done' || j.status === 'failed');
	for (const j of finished.slice(MAX_JOBS)) forget(j.id);
}

function addJob(job: JobState) {
	jobs.set(job.id, job);
	prune();
	changed(job);
}

function newJob(fields: Pick<JobState, 'kind' | 'title'> & Partial<JobState>): JobState {
	return {
		id: randomUUID(),
		createdAt: Date.now(),
		status: 'running',
		tracks: [],
		albums: [],
		backupIds: [],
		...fields
	};
}

/** With "refresh before every download" on, re-reads the browser's cookies; old ones are the fallback. */
async function refreshCookies(ctx: Ctx) {
	const { cookieBrowser, cookieProfile, cookieAutoRefresh } = ctx.settings;
	if (!cookieBrowser || !cookieAutoRefresh) return;
	try {
		await importFromBrowser(cookieBrowser, cookieProfile);
	} catch (err) {
		ctx.job.warnings = [`Cookie refresh from ${cookieBrowser} failed, using the saved cookies. ${(err as Error).message}`];
		ctx.update();
	}
}

/** Validates the URL (throws on bad input), then runs the job in the background. */
export async function createJob(rawUrl: string): Promise<JobState> {
	const input = parseInput(rawUrl);
	await ready;
	// A song link is ready to download as it is; its name arrives with the audio.
	const job = newJob({ kind: input.kind, url: input.url, title: '', status: 'resolving' });
	addJob(job);
	void run(job, async (ctx) => {
		await refreshCookies(ctx);
		const resolved = await resolveUrl(input, ctx.workDir);
		job.title = resolved.title;
		job.tracks = resolved.entries.map((e) => ({
			key: e.videoId,
			title: e.title,
			status: 'queued',
			progress: 0,
			warnings: [],
			albumIndex: e.albumIndex
		}));
		job.status = 'running';
		ctx.update();
		const albumPlaylist = resolved.entries.some((e) => e.albumIndex !== undefined);
		await runDownload(ctx, resolved.entries, albumPlaylist);
	});
	return job;
}

const isDownload = (job: JobState) => job.kind === 'track' || job.kind === 'playlist';
const isFinished = (job: JobState) => job.status === 'done' || job.status === 'failed';

/** Songs the user threw away in a review stay thrown away. */
const retryable = (t: JobState['tracks'][number]) => t.status === 'failed' && t.error !== DISCARDED;

/**
 * Tries a finished download again: only the songs that failed, in the same history entry.
 * A link that could not even be read is read again.
 */
export async function retryJob(id: string): Promise<JobState> {
	await ready;
	const job = jobs.get(id);
	if (!job) throw new Error('That download is no longer in the history.');
	if (!isDownload(job) || !job.url) throw new Error('Only downloads can be retried.');
	if (!isFinished(job)) throw new Error('This download is still running.');

	if (!job.tracks.length) {
		forget(job.id);
		return createJob(job.url);
	}

	const failed = job.tracks.filter(retryable);
	if (!failed.length) throw new Error('Nothing failed in this download.');
	for (const t of failed) {
		t.status = 'queued';
		t.progress = 0;
		t.error = undefined;
		t.errorDetail = undefined;
	}
	job.status = 'running';
	job.error = undefined;
	job.errorDetail = undefined;
	changed(job);

	const entries: ResolvedEntry[] = failed.map((t) => ({ videoId: t.key, title: t.title, albumIndex: t.albumIndex }));
	void run(job, async (ctx) => {
		await refreshCookies(ctx);
		await runDownload(ctx, entries, entries.some((e) => e.albumIndex !== undefined));
	});
	return job;
}

/** Removes one finished job from the history. Its files and backups are not touched. */
export async function removeJob(id: string): Promise<void> {
	await ready;
	const job = jobs.get(id);
	if (!job) return;
	if (!isFinished(job)) throw new Error('This one is still running or waiting for input.');
	forget(id);
	changed();
}

/** Re-tags one folder with Deezer; `edit` opens the tag editor instead of matching. */
export async function createRetagJob(folder: string, mode: RetagMode = 'auto', edit = false): Promise<JobState> {
	await ready;
	const settings = await readSettings();
	const { root } = await libraryRoot(settings);
	const abs = await albumFolder(root, folder);
	const job = newJob({ kind: edit ? 'edit' : 'retag', folder, title: folder });
	addJob(job);
	void run(job, (ctx) => runRetag(ctx, abs, mode, edit));
	return job;
}

async function contextFor(job: JobState, workDir: string): Promise<Ctx> {
	const settings = await readSettings();
	limit = settings.concurrency;
	pump();
	return { job, settings, workDir, update: () => changed(job), slot };
}

async function run(job: JobState, body: (ctx: Ctx) => Promise<void>) {
	const workDir = join(config.workDir, job.id);
	try {
		// One settings snapshot per job: changes mid-album don't split the album across folders.
		await body(await contextFor(job, workDir));
		settle(job);
	} catch (err) {
		job.status = 'failed';
		job.error = (err as Error).message;
		job.errorDetail = err instanceof DownloadError ? err.detail : undefined;
	} finally {
		for (const t of job.tracks) {
			if (!SETTLED.has(t.status)) {
				t.status = 'failed';
				t.error ??= 'Stopped before finishing.';
			}
		}
		if (job.status === 'failed' && job.tracks.some((t) => t.status === 'needs-input')) settle(job);
		await rm(workDir, { recursive: true, force: true });
		changed(job);
	}
}

/** Waits until a just-started job has parked its songs in reviews (used by "Edit tags"). */
export async function waitForReview(jobId: string, timeoutMs = 60000): Promise<string | undefined> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const job = jobs.get(jobId);
		const id = job?.tracks.find((t) => t.reviewId)?.reviewId;
		if (id && (await getReview(id))) return id;
		if (!job || job.status === 'failed' || job.status === 'done') return undefined;
		await new Promise((r) => setTimeout(r, 250));
	}
	return undefined;
}

// ---------------------------------------------------------------- reviews

const resolving = new Set<string>();

/** The job a review belongs to; recreated if it was cleared from the history. */
function jobForReview(jobId: string, kind: 'download' | 'retag' | 'edit', title: string, folder?: string): JobState {
	let job = jobs.get(jobId);
	if (!job) {
		job = newJob({ id: jobId, kind: kind === 'download' ? 'track' : kind, title, folder, status: 'needs-input' });
		addJob(job);
	}
	return job;
}

export async function resolveReview(id: string, input: ResolveInput, upload?: Buffer): Promise<void> {
	await ready;
	if (resolving.has(id)) throw new Error('This review is already being saved.');
	resolving.add(id);
	try {
		const review = await healReview(id);
		if (!review) throw new Error('This review no longer exists.');
		const job = jobForReview(review.jobId, review.kind, review.title, review.folder);
		job.status = 'running';
		changed();
		const workDir = join(config.workDir, `review-${id}`);
		try {
			await applyReview(await contextFor(job, workDir), review, input, upload);
			await removeReview(id);
		} finally {
			await rm(workDir, { recursive: true, force: true });
			settle(job);
			changed();
		}
	} finally {
		resolving.delete(id);
	}
}

export async function discardReview(id: string): Promise<void> {
	await ready;
	if (resolving.has(id)) throw new Error('This review is being saved.');
	const review = await getReview(id);
	if (!review) throw new Error('This review no longer exists.');
	const job = jobs.get(review.jobId);
	if (job) {
		discardReviewTracks(job, review);
		settle(job);
	}
	await removeReview(id);
	changed();
}

// ---------------------------------------------------------------- history and backups

/** Removes finished jobs of one kind from the history. Running jobs and ones waiting for input stay. */
export function clearFinished(kind: 'download' | 'retag'): number {
	let removed = 0;
	for (const job of [...jobs.values()]) {
		const isRetag = job.kind === 'retag' || job.kind === 'edit';
		if ((kind === 'retag') === isRetag && (job.status === 'done' || job.status === 'failed')) {
			jobs.delete(job.id);
			removed++;
		}
	}
	changed();
	return removed;
}

/** Hides "Undo" once its backups are deleted (all backups when no id is given). */
export function forgetBackup(backupId?: string) {
	for (const job of jobs.values()) {
		if (!job.backupIds.length || (backupId && !job.backupIds.includes(backupId))) continue;
		job.backupIds = backupId ? job.backupIds.filter((b) => b !== backupId) : [];
		changed(job);
	}
}

export function markRestored(backupId: string) {
	for (const job of jobs.values()) {
		if (!job.backupIds.includes(backupId)) continue;
		job.backupIds = job.backupIds.filter((b) => b !== backupId);
		if (!job.backupIds.length) job.restored = true;
		changed(job);
	}
}
