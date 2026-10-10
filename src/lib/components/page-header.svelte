<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, children, actions }: { title: string; children?: Snippet; actions?: Snippet } = $props();
</script>

<header class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
	<div class="flex min-w-0 flex-col gap-1">
		<h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
		{#if children}
			<p class="max-w-prose text-sm text-muted-foreground">{@render children()}</p>
		{/if}
	</div>
	{@render actions?.()}
</header>
