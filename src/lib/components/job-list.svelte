<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Collapsible from '$lib/components/ui/collapsible/index.js';
	import { Progress } from '$lib/components/ui/progress/index.js';
	import type { AlbumMatch, JobState, TrackState } from '$lib/types';

	let {
		jobs,
		kind,
		empty
	}: { jobs: JobState[]; kind: 'download' | 'retag'; empty: string } = $props();

	// Running jobs start expanded, finished ones collapsed, until the user toggles them.
	let toggled = $state<Record<string, boolean>>({});
	const isRunning = (j: JobState) => j.status === 'running' || j.status === 'resolving';
	const isOpen = (j: JobState) => toggled[j.id] ?? (isRunning(j) || j.status === 'needs-input');

	let busy = $state<string | null>(null);
	let actionError = $state('');
	let clearing = $state(false);
	const finishedCount = $derived(jobs.filter((j) => j.status === 'done' || j.status === 'failed').length);

	const statusLabel: Record<TrackState['status'], string> = {
		queued: 'Queued',
		downloading: 'Downloading',
		waiting: 'Waiting for album',
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

	function summary(job: JobState): string {
		if (job.status === 'resolving') return 'Reading link…';
		if (job.error) return job.error;
		const total = job.tracks.length;
		if (isRunning(job)) {
			const finished = total - job.tracks.filter((t) => !['done', 'skipped', 'failed'].includes(t.status)).length;
			return `${finished} of ${total}`;
		}
		const verb = job.kind === 'retag' || job.kind === 'edit' ? 'updated' : 'saved';
		let s = `${count(job, 'done')} of ${total} ${verb}`;
		if (count(job, 'needs-input')) s += `, ${count(job, 'needs-input')} need input`;
		if (count(job, 'skipped')) s += `, ${count(job, 'skipped')} ${job.kind === 'track' || job.kind === 'playlist' ? 'already there' : 'skipped'}`;
		if (count(job, 'failed')) s += `, ${count(job, 'failed')} failed`;
		return s;
	}

	/** Overall progress: finished tracks count fully, downloads by their percentage. */
	function progress(job: JobState): number {
		if (!job.tracks.length) return 0;
		const sum = job.tracks.reduce((acc, t) => {
			if (['done', 'skipped', 'failed'].includes(t.status)) return acc + 1;
			if (t.status === 'tagging') return acc + 0.9;
			if (t.status === 'waiting') return acc + 0.8;
			if (t.status === 'downloading') return acc + (t.progress / 100) * 0.8;
			return acc;
		}, 0);
		return Math.round((sum / job.tracks.length) * 100);
	}

	function dotClass(job: JobState) {
		if (isRunning(job)) return 'bg-sky-500 animate-pulse';
		if (job.status === 'needs-input') return 'bg-amber-500 ring-2 ring-amber-500/30';
		if (job.status === 'failed' || count(job, 'failed')) return 'bg-destructive';
		if (job.tracks.some((t) => t.warnings.length) || job.albums.some((a) => a.note)) return 'bg-amber-500';
		return 'bg-emerald-500';
	}

	/** Restores every backup the job made (a playlist folder can make one per song). */
	async function undo(job: JobState) {
		if (!job.backupIds.length) return;
		if (!confirm(`Restore the original files and tags for “${job.title}”?`)) return;
		busy = job.id;
		actionError = '';
		for (const id of [...job.backupIds].reverse()) {
			const res = await fetch(`/api/backups/${encodeURIComponent(id)}/restore`, { method: 'POST' });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				actionError = body?.message ?? 'Restore failed.';
				break;
			}
		}
		await invalidate('app:backups');
		busy = null;
	}

	async function clearFinished() {
		clearing = true;
		await fetch(`/api/jobs?kind=${kind}`, { method: 'DELETE' });
		clearing = false;
	}

	const badgeVariant = (s: TrackState['status']) =>
		s === 'failed' ? 'destructive' : s === 'done' ? 'default' : s === 'skipped' || s === 'needs-input' ? 'outline' : 'secondary';
</script>

<section class="flex flex-col gap-3" aria-live="polite">
	<div class="flex items-center justify-between gap-4">
		<h2 class="font-medium">History</h2>
		{#if finishedCount}
			<Button size="sm" variant="ghost" disabled={clearing} onclick={clearFinished}>Clear finished</Button>
		{/if}
	</div>

	{#if actionError}
		<p class="text-sm text-destructive" role="alert">{actionError}</p>
	{/if}

	{#if jobs.length === 0}
		<p class="text-sm text-muted-foreground">{empty}</p>
	{:else}
		<ul class="flex flex-col divide-y rounded-md border">
			{#each jobs as job (job.id)}
				<li>
					<Collapsible.Root bind:open={() => isOpen(job), (v) => (toggled[job.id] = v)}>
						<Collapsible.Trigger
							class="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
						>
							<span class={['size-2 shrink-0 rounded-full', dotClass(job)]} aria-hidden="true"></span>
							<span class="min-w-0 flex-1 truncate">{job.title}</span>
							<span class={['shrink-0 text-sm', job.status === 'failed' ? 'text-destructive' : 'text-muted-foreground']}>
								{summary(job)}
							</span>
							<span class={['shrink-0 text-muted-foreground transition-transform', isOpen(job) && 'rotate-90']} aria-hidden="true">›</span>
						</Collapsible.Trigger>
						{#if isRunning(job) && job.tracks.length}
							<Progress value={progress(job)} max={100} class="h-0.5 rounded-none" />
						{/if}

						<Collapsible.Content class="flex flex-col gap-3 px-3 pb-4 pt-1">
							{#if openReviews(job).length}
								<div class="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
									<span class="flex-1">
										{openReviews(job).length === 1
											? 'Deezer needs your help with this one.'
											: `${openReviews(job).length} groups need your input.`}
									</span>
									<Button size="sm" href={`/review?id=${encodeURIComponent(openReviews(job)[0])}`}>Review</Button>
								</div>
							{/if}

							{#if job.restored}
								<Badge variant="outline" class="self-start">Restored</Badge>
							{:else if job.backupIds.length && !isRunning(job)}
								<Button size="sm" variant="outline" class="self-start" disabled={busy === job.id} onclick={() => undo(job)}>
									{busy === job.id ? 'Restoring…' : 'Undo'}
								</Button>
							{/if}

							{#each job.warnings ?? [] as warning, i (i)}
								<p class="text-sm text-amber-600 dark:text-amber-400">{warning}</p>
							{/each}

							{#each job.albums as album, i (i)}
								<div class="rounded-md bg-muted/50 px-3 py-2 text-sm">
									<p>
										<span class="font-medium">{album.album}</span> by {album.albumArtist}{album.year ? ` (${album.year})` : ''}
									</p>
									<p class="text-muted-foreground">
										{#if album.deezerAlbumId}
											{album.source === 'manual' ? 'Picked on' : 'Matched on'}
											<a
												class="underline underline-offset-4"
												href={`https://www.deezer.com/album/${album.deezerAlbumId}`}
												target="_blank"
												rel="noreferrer">Deezer</a
											>{album.source === 'deezer' ? `, ${album.matched} of ${album.total} songs` : ''}.
										{:else}
											Tagged by hand.
										{/if}
										{#if album.artSource}Cover from {artLabel[album.artSource]}.{/if}
									</p>
									{#if album.note}<p class="text-amber-600 dark:text-amber-400">{album.note}</p>{/if}
								</div>
							{/each}

							<ul class="flex flex-col gap-2.5">
								{#each job.tracks as track (track.key)}
									<li class="flex flex-col gap-1">
										<div class="flex items-center justify-between gap-3 text-sm">
											<span class={['truncate', track.status === 'queued' && 'text-muted-foreground']}>{track.title}</span>
											<Badge variant={badgeVariant(track.status)}>{statusLabel[track.status]}</Badge>
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
										{#if track.error}<p class="text-xs text-destructive">{track.error}</p>{/if}
										{#each track.warnings as warning, i (i)}
											<p class="text-xs text-amber-600 dark:text-amber-400">{warning}</p>
										{/each}
									</li>
								{/each}
							</ul>
						</Collapsible.Content>
					</Collapsible.Root>
				</li>
			{/each}
		</ul>
	{/if}
</section>
