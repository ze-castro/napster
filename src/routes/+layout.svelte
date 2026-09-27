<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { provideLive } from '$lib/jobs.svelte';

	let { children } = $props();

	const live = provideLive();

	const links = [
		{ href: '/', label: 'Downloads' },
		{ href: '/library', label: 'Library' },
		{ href: '/review', label: 'Needs input' },
		{ href: '/settings', label: 'Settings' }
	];
</script>

<svelte:head>
	<title>{live.reviews.length ? `(${live.reviews.length}) napster` : 'napster'}</title>
</svelte:head>

<nav class="mx-auto flex max-w-3xl flex-wrap items-center gap-x-6 gap-y-2 px-5 pt-6 text-sm">
	<a href="/" class="flex items-center gap-2 font-semibold">
		<img src="/icon-180.png" alt="" width="28" height="28" class="size-7" />
		napster
	</a>
	{#each links as link (link.href)}
		<a
			href={link.href}
			aria-current={page.url.pathname === link.href ? 'page' : undefined}
			class={[
				'inline-flex items-center gap-1.5 underline-offset-4 hover:underline',
				page.url.pathname === link.href ? 'text-foreground underline' : 'text-muted-foreground'
			]}
		>
			{link.label}
			{#if link.href === '/review' && live.reviews.length}
				<span
					class="rounded-full bg-amber-500 px-1.5 text-xs leading-5 font-medium text-white tabular-nums"
					aria-label="{live.reviews.length} waiting"
				>
					{live.reviews.length}
				</span>
			{/if}
		</a>
	{/each}
</nav>

{@render children()}
