<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Music from '@lucide/svelte/icons/music';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import PageHeader from '$lib/components/page-header.svelte';
	import ReviewDialog from '$lib/components/review-dialog.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { timeAgo } from '$lib/format';
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
		'not-found': 'Not on Deezer',
		'close-match': 'Close match',
		edit: 'Editing tags'
	};
	const kindLabel: Record<ReviewSummary['kind'], string> = {
		download: 'Download',
		retag: 'Re-tag',
		edit: 'Library'
	};

	// Reviews without a cover fall back to the placeholder tile.
	let noCover = $state<Record<string, boolean>>({});
</script>

<main class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-5 sm:py-10">
	<PageHeader title="Needs input">
		Songs Deezer couldn't match with confidence, and folders you're editing. Downloads wait here safely until you
		save or discard them.
	</PageHeader>

	{#if live.reviews.length === 0}
		<div class="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center">
			<CircleCheck class="size-5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
			<p class="text-sm font-medium">All caught up</p>
			<p class="text-sm text-muted-foreground">Nothing is waiting for you.</p>
		</div>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each live.reviews as r (r.id)}
				<li>
					<button
						class="flex w-full items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
						onclick={() => openReview(r.id)}
					>
						{#if noCover[r.id]}
							<span class="flex size-11 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground" aria-hidden="true">
								<Music class="size-5" />
							</span>
						{:else}
							<img
								src={`/api/reviews/${encodeURIComponent(r.id)}/cover`}
								alt=""
								loading="lazy"
								class="size-11 shrink-0 rounded-md bg-muted object-cover"
								onerror={() => (noCover[r.id] = true)}
							/>
						{/if}
						<span class="flex min-w-0 flex-1 flex-col">
							<span class="truncate font-medium">{r.title}</span>
							<span class="truncate text-sm text-muted-foreground">
								{kindLabel[r.kind]} · {r.songs} {r.songs === 1 ? 'song' : 'songs'} · {timeAgo(r.createdAt)}
							</span>
							{#if r.note}<span class="truncate text-xs text-amber-700 dark:text-amber-400">{r.note}</span>{/if}
						</span>
						<Badge
							variant="outline"
							class={[
								'shrink-0',
								r.reason === 'edit'
									? ''
									: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300'
							]}
						>
							{reasonLabel[r.reason]}
						</Badge>
						<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<ReviewDialog reviewId={openId} bind:open={() => !!openId, (v) => !v && closed()} />
