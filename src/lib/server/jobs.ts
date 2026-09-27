import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobState, ResolveInput, ReviewSummary } from '$lib/types';
import { config } from './config';
import { importFromBrowser } from './cookies';
import { albumFolder, libraryRoot } from './library';
import {
	applyReview,
	discardReviewTracks,
	runDownload,
	runRetag,
	settle,
	type Ctx,
	type RetagMode,
	type Slot
} from './pipeline';
import { allReviews, getReview, healReview, removeReview, summary } from './reviews';
import { readSettings } from './settings';
import { readJson, writeJson } from './store';
import { parseInput, resolveUrl } from './ytdlp';

const MAX_JOBS = 50;
// Renamed from jobs.json when metadata moved to Deezer: older history is dropped.
const FILE = join(config.dataDir, 'history.json');
const OLD_FILE = join(config.dataDir, 'jobs.json');
const jobs = new Map<string, JobState>();
const bus = new EventTarget();

const SETTLED = new Set(['done', 'skipped', 'failed', 'needs-input']);

/** Loads history once; anything that was mid-flight when the server stopped is marked failed. */
export const ready: Promise<void> = (async () => {
	await rm(OLD_FILE, { force: true });
	for (const job of (await readJson<JobState[]>(FILE)) ?? []) {
		for (const t of job.tracks) {
			if (!SETTLED.has(t.status)) {
				t.status = 'failed';
				t.error ??= 'Interrupted by a restart.';
			}
		}
		if (job.status === 'resolving' || job.status === 'running') {
			job.error ??= 'Interrupted by a restart.';
			settle(job);
			if (!job.tracks.length) job.status = 'failed';
		}
		jobs.set(job.id, job);
	}
	await refreshReviews();
})();

// ---------------------------------------------------------------- change notifications

let reviewSummaries: ReviewSummary[] = [];

async function refreshReviews() {
	reviewSummaries = (await allReviews()).map(summary).sort((a, b) => b.createdAt - a.createdAt);
}

// Coalesce progress spam into at most ~5 UI updates and 1 disk write per second.
let notifyPending = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function changed() {
	if (!notifyPending) {
		notifyPending = true;
		setTimeout(async () => {
			notifyPending = false;
			await refreshReviews().catch(() => undefined);
			bus.dispatchEvent(new Event('change'));
		}, 200);
	}
	persistTimer ??= setTimeout(() => {
		persistTimer = undefined;
		writeJson(FILE, listJobs()).catch((err) => console.error('[napster] saving history failed', err));
	}, 1000);
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
	return { jobs: listJobs(), reviews: reviewSummaries };
}

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
	for (const j of finished.slice(MAX_JOBS)) jobs.delete(j.id);
}

function addJob(job: JobState) {
	jobs.set(job.id, job);
	prune();
	changed();
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

/** Validates the URL (throws on bad input), then runs the job in the background. */
export async function createJob(rawUrl: string): Promise<JobState> {
	const { url, kind } = parseInput(rawUrl);
	await ready;
	const job = newJob({ kind, url, title: url, status: 'resolving' });
	addJob(job);
	void run(job, async (ctx) => {
		const { cookieBrowser, cookieProfile, cookieAutoRefresh } = ctx.settings;
		if (cookieBrowser && cookieAutoRefresh) {
			try {
				await importFromBrowser(cookieBrowser, cookieProfile);
			} catch (err) {
				job.warnings = [`Cookie refresh from ${cookieBrowser} failed, using the saved cookies. ${(err as Error).message}`];
				changed();
			}
		}
		const resolved = await resolveUrl(url, kind, ctx.workDir);
		job.title = resolved.title;
		job.tracks = resolved.entries.map((e) => ({
			key: e.videoId,
			title: e.title,
			status: 'queued',
			progress: 0,
			warnings: []
		}));
		job.status = 'running';
		changed();
		const albumPlaylist = resolved.entries.some((e) => e.albumIndex !== undefined);
		await runDownload(ctx, resolved.entries, albumPlaylist);
	});
	return job;
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
	return { job, settings, workDir, update: changed, slot };
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
	} finally {
		for (const t of job.tracks) {
			if (!SETTLED.has(t.status)) {
				t.status = 'failed';
				t.error ??= 'Stopped before finishing.';
			}
		}
		if (job.status === 'failed' && job.tracks.some((t) => t.status === 'needs-input')) settle(job);
		await rm(workDir, { recursive: true, force: true });
		changed();
	}
}

/** Waits until a just-started job has parked its songs in reviews (used by "Edit tags"). */
export async function waitForReview(jobId: string, timeoutMs = 60000): Promise<string | undefined> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const job = jobs.get(jobId);
		const id = job?.tracks.find((t) => t.reviewId)?.reviewId;
		if (id && reviewSummaries.some((r) => r.id === id)) return id;
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
		job.backupIds = backupId ? job.backupIds.filter((b) => b !== backupId) : [];
	}
	changed();
}

export function markRestored(backupId: string) {
	for (const job of jobs.values()) {
		if (!job.backupIds.includes(backupId)) continue;
		job.backupIds = job.backupIds.filter((b) => b !== backupId);
		if (!job.backupIds.length) job.restored = true;
	}
	changed();
}
