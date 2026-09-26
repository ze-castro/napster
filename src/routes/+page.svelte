<script lang="ts">
	import JobList from '$lib/components/job-list.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { jobStream } from '$lib/jobs.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const stream = jobStream();
	const downloads = $derived(stream.jobs.filter((j) => j.kind !== 'retag'));

	let url = $state('');
	let submitting = $state(false);
	let formError = $state('');

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!url.trim() || submitting) return;
		submitting = true;
		formError = '';
		try {
			const res = await fetch('/api/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url })
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				formError = body?.message ?? `Request failed (${res.status}).`;
				return;
			}
			url = '';
		} catch {
			formError = 'Could not reach the server.';
		} finally {
			submitting = false;
		}
	}
</script>

<main class="mx-auto flex min-h-screen max-w-3xl flex-col gap-10 px-5 py-10">
	<header class="flex items-baseline justify-between gap-4">
		<h1 class="text-4xl font-semibold tracking-tight">Downloads</h1>
		<span class="flex items-center gap-2 text-sm text-muted-foreground">
			<span class={['size-2 rounded-full', stream.connected ? 'bg-emerald-500' : 'bg-muted-foreground/40']}></span>
			{stream.connected ? 'Connected' : 'Reconnecting'}
		</span>
	</header>

	<form onsubmit={submit} class="flex flex-col gap-2">
		<label for="url" class="text-sm text-muted-foreground">
			Paste a song, album or playlist link from YouTube Music
		</label>
		<div class="flex gap-2">
			<Input
				id="url"
				type="url"
				placeholder="https://music.youtube.com/watch?v=…"
				bind:value={url}
				autocomplete="off"
				class="h-11"
			/>
			<Button type="submit" disabled={submitting || !url.trim()} class="h-11 px-6">
				{submitting ? 'Adding…' : 'Download'}
			</Button>
		</div>
		{#if formError}
			<p class="text-sm text-destructive" role="alert">{formError}</p>
		{/if}
		<p class="text-sm text-muted-foreground">
			Saving to <span class="font-mono">{data.libraryDir}</span>
		</p>
		{#if !data.hasMbContact}
			<p class="text-sm text-amber-600 dark:text-amber-400">
				Songs will only get YouTube's tags.
				<a href="/settings" class="underline underline-offset-4">Add a MusicBrainz contact</a> for full metadata.
			</p>
		{/if}
	</form>

	<JobList jobs={downloads} kind="download" empty="Songs are filed as Album Artist / Album / 01. Title.m4a." />
</main>
