<script lang="ts">
	import Link from '@lucide/svelte/icons/link';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import JobList from '$lib/components/job-list.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { useLive } from '$lib/jobs.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const stream = useLive();
	const downloads = $derived(stream.jobs.filter((j) => j.kind === 'track' || j.kind === 'playlist'));

	let url = $state('');
	let submitting = $state(false);
	let formError = $state('');
	let input = $state<HTMLInputElement | null>(null);

	/** Several links can be pasted at once, separated by spaces or line breaks. */
	const links = $derived(url.split(/\s+/).filter(Boolean));

	async function add(link: string): Promise<string | undefined> {
		try {
			const res = await fetch('/api/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: link })
			});
			if (res.ok) return undefined;
			const body = (await res.json().catch(() => null)) as { message?: string } | null;
			return body?.message ?? `Request failed (${res.status}).`;
		} catch {
			return 'Could not reach the server.';
		}
	}

	async function submit(event?: SubmitEvent) {
		event?.preventDefault();
		if (!links.length || submitting) return;
		submitting = true;
		formError = '';
		const rejected: string[] = [];
		let reason = '';
		for (const link of links) {
			const error = await add(link);
			if (error) {
				rejected.push(link);
				reason = error;
			}
		}
		// Links that didn't go through stay in the box to be fixed.
		const sent = links.length - rejected.length;
		url = rejected.join(' ');
		if (rejected.length) formError = sent ? `${sent} added, ${rejected.length} not: ${reason}` : reason;
		submitting = false;
		input?.focus();
	}

	/** Pasting a link anywhere on the page starts it, without clicking into the box first. */
	function pasteAnywhere(event: ClipboardEvent) {
		const target = event.target as HTMLElement | null;
		if (target?.closest('input, textarea, [contenteditable]')) return;
		const text = event.clipboardData?.getData('text').trim() ?? '';
		if (!/^https:\/\/((music|www|m)\.)?youtu(be\.com|\.be)\//.test(text)) return;
		event.preventDefault();
		url = text;
		void submit();
	}
</script>

<svelte:window onpaste={pasteAnywhere} />

<main class="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-5 sm:py-10">
	<PageHeader title="Downloads">
		Paste a song, album or playlist link from YouTube Music. It's tagged, given its cover and filed in your library.
	</PageHeader>

	<form onsubmit={submit} class="flex flex-col gap-2">
		<div
			class={[
				'flex items-center gap-1.5 rounded-xl border bg-card p-1.5 shadow-xs transition-shadow',
				'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30',
				formError && 'border-destructive/60'
			]}
		>
			<Link class="ml-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			<!-- svelte-ignore a11y_autofocus -->
			<input
				bind:this={input}
				bind:value={url}
				id="url"
				type="text"
				inputmode="url"
				placeholder="https://music.youtube.com/…"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				autofocus
				aria-label="YouTube Music link"
				aria-invalid={formError ? 'true' : undefined}
				aria-describedby="url-hint"
				class="h-10 min-w-0 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground/70 sm:text-sm"
			/>
			<Button type="submit" disabled={submitting || !links.length} class="h-10 px-4 sm:px-5">
				{#if submitting}<LoaderCircle class="animate-spin" />{/if}
				{links.length > 1 ? `Download ${links.length}` : 'Download'}
			</Button>
		</div>
		{#if formError}
			<p class="px-1 text-sm text-destructive" role="alert">{formError}</p>
		{/if}
		<p id="url-hint" class="px-1 text-sm text-muted-foreground">
			Saving to <span class="font-mono text-[0.8125rem] break-all">{data.libraryDir}</span>
		</p>
	</form>

	<JobList
		jobs={downloads}
		kind="download"
		empty="Nothing downloaded yet. Songs are filed as Album Artist / Album / 01. Title.m4a."
	/>
</main>
