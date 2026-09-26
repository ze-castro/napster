import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobState } from '$lib/types';
import { config } from './config';
import { importFromBrowser } from './cookies';
import { albumFolder, libraryRoot } from './library';
import { runDownload, runRetag, type Slot } from './pipeline';
import { readSettings } from './settings';
import { readJson, writeJson } from './store';
import { parseInput, resolveUrl } from './ytdlp';

const MAX_JOBS = 50;
const FILE = join(config.dataDir, 'jobs.json');
const jobs = new Map<string, JobState>();
const bus = new EventTarget();

const FINISHED = new Set(['done', 'skipped', 'failed']);

/** Loads history once; anything that was mid-flight when the server stopped is marked failed. */
export const ready: Promise<void> = (async () => {
	for (const job of (await readJson<JobState[]>(FILE)) ?? []) {
		job.albums ??= []; // history from older versions
		if (job.status === 'resolving' || job.status === 'running') {
			job.status = 'failed';
			job.error ??= 'Interrupted by a restart.';
		}
		for (const t of job.tracks) {
			if (!FINISHED.has(t.status)) {
				t.status = 'failed';
				t.error ??= 'Interrupted by a restart.';
			}
		}
		jobs.set(job.id, job);
	}
})();

// Coalesce progress spam into at most ~5 UI updates and 1 disk write per second.
let notifyPending = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function changed() {
	if (!notifyPending) {
		notifyPending = true;
		setTimeout(() => {
			notifyPending = false;
			bus.dispatchEvent(new Event('change'));
		}, 200);
	}
	persistTimer ??= setTimeout(() => {
		persistTimer = undefined;
		writeJson(FILE, listJobs()).catch((err) => console.error('[napster] saving jobs failed', err));
	}, 1000);
}

export function subscribe(cb: () => void): () => void {
	bus.addEventListener('change', cb);
	return () => bus.removeEventListener('change', cb);
}

export function listJobs(): JobState[] {
	return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

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

function acquire(): Promise<void> {
	return new Promise((r) => {
		waiters.push(r);
		pump();
	});
}

function release() {
	active--;
	pump();
}

const slot: Slot = async (fn) => {
	await acquire();
	try {
		return await fn();
	} finally {
		release();
	}
};

function prune() {
	const finished = listJobs().filter((j) => j.status === 'done' || j.status === 'failed');
	for (const j of finished.slice(MAX_JOBS)) jobs.delete(j.id);
}

function addJob(job: JobState) {
	jobs.set(job.id, job);
	prune();
	changed();
}

/** Validates the URL (throws on bad input), then runs the job in the background. */
export async function createJob(rawUrl: string): Promise<JobState> {
	const { url, kind } = parseInput(rawUrl);
	await ready;
	const job: JobState = {
		id: randomUUID(),
		url,
		kind,
		title: url,
		createdAt: Date.now(),
		status: 'resolving',
		tracks: [],
		albums: []
	};
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

/** Re-tags one album folder in the library (backed up first). */
export async function createRetagJob(folder: string): Promise<JobState> {
	await ready;
	const settings = await readSettings();
	const { root } = await libraryRoot(settings);
	const abs = await albumFolder(root, folder);
	const job: JobState = {
		id: randomUUID(),
		kind: 'retag',
		folder,
		title: folder,
		createdAt: Date.now(),
		status: 'running',
		tracks: [],
		albums: []
	};
	addJob(job);
	void run(job, (ctx) => runRetag(ctx, abs));
	return job;
}

/** Hides "Undo re-tag" once its backup is deleted (all backups when no id is given). */
export function forgetBackup(backupId?: string) {
	for (const job of jobs.values()) {
		if (job.backupId && (!backupId || job.backupId === backupId)) job.backupId = undefined;
	}
	changed();
}

/** Removes finished jobs of one kind from the history. Running jobs stay. */
export function clearFinished(kind: 'download' | 'retag'): number {
	let removed = 0;
	for (const job of [...jobs.values()]) {
		const matches = kind === 'retag' ? job.kind === 'retag' : job.kind !== 'retag';
		if (matches && (job.status === 'done' || job.status === 'failed')) {
			jobs.delete(job.id);
			removed++;
		}
	}
	changed();
	return removed;
}

export function markRestored(backupId: string) {
	for (const job of jobs.values()) {
		if (job.backupId === backupId) job.restored = true;
	}
	changed();
}

async function run(job: JobState, body: (ctx: Parameters<typeof runRetag>[0]) => Promise<void>) {
	const workDir = join(config.workDir, job.id);
	try {
		// One snapshot per job: settings changed mid-album don't split the album across folders.
		const settings = await readSettings();
		limit = settings.concurrency;
		pump();
		await body({ job, settings, workDir, update: changed, slot });
		job.status = job.tracks.length && job.tracks.every((t) => t.status === 'failed') ? 'failed' : 'done';
	} catch (err) {
		job.status = 'failed';
		job.error = (err as Error).message;
	} finally {
		for (const t of job.tracks) {
			if (!FINISHED.has(t.status)) {
				t.status = 'failed';
				t.error ??= 'Stopped before finishing.';
			}
		}
		await rm(workDir, { recursive: true, force: true });
		changed();
	}
}
