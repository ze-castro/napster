<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ReviewDialog from '$lib/components/review-dialog.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { useLive } from '$lib/jobs.svelte';
	import type { ReviewSummary } from '$lib/types';

	const live = useLive();

	// The open review lives in the URL (?id=…), so links from Downloads/Library open it directly.
	const openId = $derived(page.url.searchParams.get('id'));

	function openReview(id: string) {
		goto(`/review?id=${encodeURIComponent(id)}`, { noScroll: true, keepFocus: true });
	}

	/** Closing the dialog (Esc, ×, saved, discarded) clears ?id. */
	function closed() {
		if (openId) goto('/review', { replaceState: true, noScroll: true, keepFocus: true });
	}

	const reasonLabel: Record<ReviewSummary['reason'], string> = {
		'not-found': 'Not found',
		'close-match': 'Close match',
		edit: 'Edit tags'
	};
	const kindLabel: Record<ReviewSummary['kind'], string> = {
		download: 'Download',
		retag: 'Re-tag',
		edit: 'Library'
	};
	const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<main class="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-5 py-10">
	<header class="flex flex-col gap-1">
		<h1 class="text-4xl font-semibold tracking-tight">Needs input</h1>
		<p class="text-sm text-muted-foreground">
			Songs Deezer couldn't match with confidence, and folders you're editing. Downloaded songs wait here safely until you save or discard them.
		</p>
	</header>

	{#if live.reviews.length === 0}
		<p class="text-sm text-muted-foreground">Nothing waiting. Everything was matched.</p>
	{:else}
		<ul class="flex flex-col divide-y rounded-md border">
			{#each live.reviews as r (r.id)}
				<li>
					<button class="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-muted/50" onclick={() => openReview(r.id)}>
						<span class="flex min-w-0 flex-1 flex-col gap-0.5">
							<span class="truncate font-medium">{r.title}</span>
							<span class="truncate text-sm text-muted-foreground">
								{kindLabel[r.kind]}, {r.songs} {r.songs === 1 ? 'song' : 'songs'}, {dateFormat.format(r.createdAt)}
							</span>
							{#if r.note}<span class="truncate text-xs text-amber-700 dark:text-amber-400">{r.note}</span>{/if}
						</span>
						<Badge variant={r.reason === 'close-match' ? 'secondary' : 'outline'} class="shrink-0">{reasonLabel[r.reason]}</Badge>
						<span class="shrink-0 text-muted-foreground" aria-hidden="true">›</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<ReviewDialog reviewId={openId} bind:open={() => !!openId, (v) => !v && closed()} />
