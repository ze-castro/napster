<script lang="ts">
	import { invalidate } from '$app/navigation';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import Clock from '@lucide/svelte/icons/clock';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Music from '@lucide/svelte/icons/music';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import X from '@lucide/svelte/icons/x';
	import ErrorNote from '$lib/components/error-note.svelte';
	import FolderCover from '$lib/components/folder-cover.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Collapsible from '$lib/components/ui/collapsible/index.js';
	import { Progress } from '$lib/components/ui/progress/index.js';
	import { timeAgo } from '$lib/format';
	import type { AlbumMatch, JobState, TrackState } from '$lib/types';

	let {
		jobs,
		kind,
		title = 'History',
		empty
	}: { jobs: JobState[]; kind: 'download' | 'retag'; title?: string; empty: string } = $props();

	// Running jobs start expanded, finished ones collapsed, until the user toggles them.
	let toggled = $state<Record<string, boolean>>({});
	const isRunning = (j: JobState) => j.status === 'running' || j.status === 'resolving';
	const isFinished = (j: JobState) => j.status === 'done' || j.status === 'failed';
	const isOpen = (j: JobState) => toggled[j.id] ?? (isRunning(j) || j.status === 'needs-input');

	let busy = $state<string | null>(null);
	let actionError = $state('');
	let clearing = $state(false);
	const finishedCount = $derived(jobs.filter(isFinished).length);

	const statusLabel: Record<TrackState['status'], string> = {
		queued: 'Queued',
		downloading: 'Downloading',
		waiting: 'Waiting for the album',
		tagging: 'Tagging',
		'needs-input': 'Needs input',
		done: 'Saved',
		skipped: 'Already in library',
		failed: 'Failed'
	};

	const artLabel: Record<NonNullable<AlbumMatch['artSource']>, string> = {
		deezer: 'Deezer',
		youtube: 'the YouTube thumbnail',
		existing: 'the existing cover',
		upload: 'an uploaded image',
		url: 'an image URL'
	};

	/** Review ids still open for a job, in track order. */
	const openReviews = (job: JobState) => [
		...new Set(job.tracks.filter((t) => t.status === 'needs-input' && t.reviewId).map((t) => t.reviewId!))
	];

	const count = (job: JobState, s: TrackState['status']) => job.tracks.filter((t) => t.status === s).length;
	const isDownload = (job: JobState) => job.kind === 'track' || job.kind === 'playlist';
	/** Songs thrown away in a review are a choice, not a failure to retry. */
	const canRetry = (job: JobState) =>
		isDownload(job) &&
		!!job.url &&
		isFinished(job) &&
		(!job.tracks.length || job.tracks.some((t) => t.status === 'failed' && t.error !== 'Discarded.'));

	type Tone = 'running' | 'attention' | 'failed' | 'warning' | 'ok';
	function tone(job: JobState): Tone {
		if (isRunning(job)) return 'running';
		if (job.status === 'needs-input') return 'attention';
		if (job.status === 'failed') return 'failed';
		if (count(job, 'failed')) return 'warning';
		return 'ok';
	}

	function chip(job: JobState): string {
		const total = job.tracks.length;
		if (job.status === 'resolving') return 'Reading link';
		if (isRunning(job)) {
			if (total <= 1) return statusLabel[job.tracks[0]?.status ?? 'queued'];
			const finished = job.tracks.filter((t) => ['done', 'skipped', 'failed', 'needs-input'].includes(t.status)).length;
			return `${finished} of ${total}`;
		}
		if (job.status === 'needs-input') return 'Needs input';
		if (job.status === 'failed') return 'Failed';
		if (job.restored) return 'Undone';
		const done = count(job, 'done') + count(job, 'skipped');
		if (total > 1 && done < total) return `${done} of ${total}`;
		if (total && count(job, 'skipped') === total) return isDownload(job) ? 'Already there' : 'Unchanged';
		return isDownload(job) ? 'Saved' : 'Updated';
	}

	/** The line under the title: what it is, how it went, when. */
	function subtitle(job: JobState): string {
		const parts: string[] = [];
		const album = job.albums[0];
		if (job.kind === 'track' && album) parts.push(album.album);
		else if (job.tracks.length > 1) parts.push(`${job.tracks.length} songs`);
		if (isFinished(job)) {
			if (job.tracks.length > 1 && count(job, 'failed')) parts.push(`${count(job, 'failed')} failed`);
			if (job.tracks.length > 1 && count(job, 'skipped')) {
				parts.push(`${count(job, 'skipped')} ${isDownload(job) ? 'already there' : 'skipped'}`);
			}
		}
		parts.push(timeAgo(job.createdAt));
		return parts.join(' · ');
	}

	/** Why a job failed, in one line: its own error, or the first song's. */
	const headline = (job: JobState) =>
		job.error ?? (job.status === 'failed' ? job.tracks.find((t) => t.error)?.error : undefined);

	const displayTitle = (job: JobState) =>
		job.title || (isRunning(job) ? 'Reading link…' : (job.url?.replace(/^https:\/\//, '') ?? 'Untitled'));

	/** Songs waiting in a review aren't in the library yet; the review has their cover. */
	const reviewCover = (job: JobState) => {
		const id = openReviews(job)[0];
		return id && !noCover[id] ? id : undefined;
	};
	let noCover = $state<Record<string, boolean>>({});

	/** The library folder a job's songs ended up in, for its cover. */
	function coverFolder(job: JobState): string | undefined {
		const path = job.tracks.find((t) => t.path)?.path;
		return path?.includes('/') ? path.split('/').slice(0, -1).join('/') : undefined;
	}

	/** Overall progress: finished tracks count fully, downloads by their percentage. */
	function progress(job: JobState): number {
		if (!job.tracks.length) return 0;
		const sum = job.tracks.reduce((acc, t) => {
			if (['done', 'skipped', 'failed', 'needs-input'].includes(t.status)) return acc + 1;
			if (t.status === 'tagging') return acc + 0.9;
			if (t.status === 'waiting') return acc + 0.8;
			if (t.status === 'downloading') return acc + (t.progress / 100) * 0.8;
			return acc;
		}, 0);
		return Math.round((sum / job.tracks.length) * 100);
	}

	async function call(job: JobState, request: () => Promise<Response>, fallback: string): Promise<boolean> {
		busy = job.id;
		actionError = '';
		try {
			const res = await request();
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				actionError = body?.message ?? fallback;
			}
			return res.ok;
		} catch {
			actionError = 'Could not reach the server.';
			return false;
		} finally {
			busy = null;
		}
	}

	async function retry(job: JobState) {
		const ok = await call(
			job,
			() => fetch(`/api/jobs/${encodeURIComponent(job.id)}/retry`, { method: 'POST' }),
			'Could not retry.'
		);
		if (ok) delete toggled[job.id];
	}

	const remove = (job: JobState) =>
		call(job, () => fetch(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' }), 'Could not remove it.');

	/** Restores every backup the job made (a playlist folder can make one per song). */
	async function undo(job: JobState) {
		if (!job.backupIds.length) return;
		if (!confirm(`Restore the original files and tags for “${job.title}”?`)) return;
		for (const id of [...job.backupIds].reverse()) {
			const ok = await call(
				job,
				() => fetch(`/api/backups/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
				'Restore failed.'
			);
			if (!ok) break;
		}
		await invalidate('app:backups');
	}

	async function clearFinished() {
		clearing = true;
		await fetch(`/api/jobs?kind=${kind}`, { method: 'DELETE' }).catch(() => undefined);
		clearing = false;
	}

	const tile: Record<Tone, string> = {
		running: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
		attention: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
		failed: 'bg-destructive/10 text-destructive',
		warning: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
		ok: 'bg-muted text-muted-foreground'
	};
	const chipClass: Record<Tone, string> = {
		running: 'border-transparent bg-sky-500/10 text-sky-700 dark:text-sky-300',
		attention: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300',
		failed: 'border-transparent bg-destructive/10 text-destructive',
		warning: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300',
		ok: 'border-transparent bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
	};
</script>

{#snippet trackIcon(status: TrackState['status'])}
	{#if status === 'downloading' || status === 'tagging'}
		<LoaderCircle class="size-4 animate-spin text-sky-600 dark:text-sky-400" />
	{:else if status === 'done'}
		<Check class="size-4 text-emerald-600 dark:text-emerald-400" />
	{:else if status === 'skipped'}
		<Check class="size-4 text-muted-foreground" />
	{:else if status === 'failed'}
		<CircleX class="size-4 text-destructive" />
	{:else if status === 'needs-input'}
		<CircleAlert class="size-4 text-amber-600 dark:text-amber-400" />
	{:else}
		<Clock class="size-4 text-muted-foreground/60" />
	{/if}
{/snippet}

<section class="flex flex-col gap-3" aria-live="polite">
	<div class="flex min-h-8 items-center justify-between gap-4">
		<h2 class="text-sm font-medium text-muted-foreground">
			{title}
			{#if jobs.length}<span class="ml-1 tabular-nums opacity-70">{jobs.length}</span>{/if}
		</h2>
		{#if finishedCount}
			<Button size="sm" variant="ghost" class="text-muted-foreground" disabled={clearing} onclick={clearFinished}>
				Clear finished
			</Button>
		{/if}
	</div>

	{#if actionError}
		<p class="text-sm text-destructive" role="alert">{actionError}</p>
	{/if}

	{#if jobs.length === 0}
		<div class="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
			<Music class="size-5 text-muted-foreground/60" aria-hidden="true" />
			<p class="max-w-sm text-sm text-muted-foreground">{empty}</p>
		</div>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each jobs as job (job.id)}
				{@const t = tone(job)}
				{@const folder = coverFolder(job)}
				{@const why = headline(job)}
				<li class="overflow-hidden rounded-xl border bg-card">
					<Collapsible.Root bind:open={() => isOpen(job), (v) => (toggled[job.id] = v)}>
						<Collapsible.Trigger
							class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
						>
							{#if folder && t !== 'running'}
								<FolderCover path={folder} version={job.createdAt} class="size-10 rounded-md" />
							{:else if reviewCover(job) && t !== 'running'}
								{@const id = reviewCover(job)!}
								<img
									src={`/api/reviews/${encodeURIComponent(id)}/cover`}
									alt=""
									loading="lazy"
									class="size-10 shrink-0 rounded-md bg-muted object-cover"
									onerror={() => (noCover[id] = true)}
								/>
							{:else}
								<span class={['flex size-10 shrink-0 items-center justify-center rounded-md', tile[t]]} aria-hidden="true">
									{#if t === 'running'}
										<LoaderCircle class="size-5 animate-spin" />
									{:else if t === 'failed'}
										<CircleX class="size-5" />
									{:else if t === 'attention' || t === 'warning'}
										<CircleAlert class="size-5" />
									{:else}
										<Music class="size-5" />
									{/if}
								</span>
							{/if}
							<span class="flex min-w-0 flex-1 flex-col">
								<span class="truncate font-medium">{displayTitle(job)}</span>
								<span class={['truncate text-sm', why && t === 'failed' ? 'text-destructive' : 'text-muted-foreground']}>
									{why && t === 'failed' ? why : subtitle(job)}
								</span>
							</span>
							<Badge variant="outline" class={['shrink-0 tabular-nums', chipClass[t]]}>{chip(job)}</Badge>
							<ChevronDown
								class={['size-4 shrink-0 text-muted-foreground transition-transform', isOpen(job) && 'rotate-180']}
								aria-hidden="true"
							/>
						</Collapsible.Trigger>
						{#if isRunning(job)}
							{#if progress(job) > 0}
								<Progress value={progress(job)} max={100} class="h-0.5 rounded-none" />
							{:else}
								<div class="h-0.5 overflow-hidden bg-muted" role="progressbar" aria-label="Working">
									<div class="progress-indeterminate h-full w-1/3 rounded-full bg-primary"></div>
								</div>
							{/if}
						{/if}

						<Collapsible.Content class="flex flex-col gap-3 border-t px-3 pt-3 pb-3">
							{#if openReviews(job).length}
								<div class="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
									<span class="flex-1">
										{openReviews(job).length === 1
											? 'Deezer wasn’t sure about this one. Have a look before it’s saved.'
											: `${openReviews(job).length} groups are waiting for you to check their tags.`}
									</span>
									<Button size="sm" href={`/review?id=${encodeURIComponent(openReviews(job)[0])}`}>Review</Button>
								</div>
							{/if}

							{#if job.error}
								<ErrorNote message={job.error} detail={job.errorDetail} />
							{/if}

							{#each job.warnings ?? [] as warning, i (i)}
								<p class="text-sm text-amber-700 dark:text-amber-400">{warning}</p>
							{/each}

							{#each job.albums as album, i (i)}
								<div class="rounded-lg bg-muted/50 px-3 py-2 text-sm">
									<p>
										<span class="font-medium">{album.album}</span>
										<span class="text-muted-foreground">by</span>
										{album.albumArtist}{album.year ? ` (${album.year})` : ''}
									</p>
									<p class="text-muted-foreground">
										{#if album.deezerAlbumId}
											{album.source === 'manual' ? 'Picked on' : 'Matched on'}
											<a
												class="underline underline-offset-4 hover:text-foreground"
												href={`https://www.deezer.com/album/${album.deezerAlbumId}`}
												target="_blank"
												rel="noreferrer">Deezer</a
											>{album.source === 'deezer' ? `, ${album.matched} of ${album.total} songs` : ''}.
										{:else}
											Tagged by hand.
										{/if}
										{#if album.artSource}Cover from {artLabel[album.artSource]}.{/if}
									</p>
									{#if album.note}<p class="text-amber-700 dark:text-amber-400">{album.note}</p>{/if}
								</div>
							{/each}

							{#if job.tracks.length}
								<ul class="flex flex-col">
									{#each job.tracks as track (track.key)}
										<li class="flex gap-2.5 py-1.5">
											<span class="mt-0.5 shrink-0" title={statusLabel[track.status]}>
												{@render trackIcon(track.status)}
											</span>
											<div class="flex min-w-0 flex-1 flex-col gap-1">
												<div class="flex items-baseline justify-between gap-3 text-sm">
													<span class={['truncate', track.status === 'queued' && 'text-muted-foreground']}>
														{track.title || 'Reading link…'}
													</span>
													<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
														{track.status === 'downloading' && track.progress
															? `${Math.round(track.progress)}%`
															: statusLabel[track.status]}
													</span>
												</div>
												{#if track.status === 'downloading'}
													<Progress value={track.progress} max={100} class="h-1" />
												{/if}
												{#if track.path}
													<p class="truncate font-mono text-xs text-muted-foreground" title={track.path}>{track.path}</p>
												{/if}
												{#each track.changes ?? [] as change, i (i)}
													<p class="text-xs text-muted-foreground">{change}</p>
												{/each}
												{#if track.error}
													<ErrorNote message={track.error} detail={track.errorDetail} compact />
												{/if}
												{#each track.warnings as warning, i (i)}
													<p class="text-xs text-amber-700 dark:text-amber-400">{warning}</p>
												{/each}
											</div>
										</li>
									{/each}
								</ul>
							{/if}

							{#if !isRunning(job)}
								<div class="flex flex-wrap items-center gap-1.5">
									{#if canRetry(job)}
										<Button size="sm" disabled={busy === job.id} onclick={() => retry(job)}>
											<RotateCw />
											{job.tracks.length > 1 ? 'Retry failed songs' : 'Try again'}
										</Button>
									{/if}
									{#if job.restored}
										<Badge variant="outline">Restored</Badge>
									{:else if job.backupIds.length}
										<Button size="sm" variant="outline" disabled={busy === job.id} onclick={() => undo(job)}>
											<Undo2 />
											{busy === job.id ? 'Restoring…' : 'Undo'}
										</Button>
									{/if}
									{#if job.url}
										<Button size="sm" variant="ghost" href={job.url} target="_blank" rel="noreferrer" class="text-muted-foreground">
											<ExternalLink />
											Open link
										</Button>
									{/if}
									{#if isFinished(job)}
										<Button
											size="sm"
											variant="ghost"
											class="ml-auto text-muted-foreground"
											disabled={busy === job.id}
											onclick={() => remove(job)}
										>
											<X />
											Remove
										</Button>
									{/if}
								</div>
							{/if}
						</Collapsible.Content>
					</Collapsible.Root>
				</li>
			{/each}
		</ul>
	{/if}
</section>
