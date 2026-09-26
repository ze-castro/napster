<script lang="ts">
	let { path, version, class: cls = 'size-10' }: { path: string; version: number; class?: string } = $props();

	const src = $derived(`/api/library/cover?path=${encodeURIComponent(path)}&v=${version}`);
	let failedSrc = $state<string | null>(null);
</script>

{#if failedSrc === src}
	<div class={['shrink-0 rounded bg-muted', cls]} aria-hidden="true"></div>
{:else}
	<img
		{src}
		alt=""
		loading="lazy"
		decoding="async"
		class={['shrink-0 rounded bg-muted object-cover', cls]}
		onerror={() => (failedSrc = src)}
	/>
{/if}
