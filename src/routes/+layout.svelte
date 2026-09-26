<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';

	let { children } = $props();

	const links = [
		{ href: '/', label: 'Downloads' },
		{ href: '/library', label: 'Library' },
		{ href: '/settings', label: 'Settings' }
	];
</script>

<svelte:head>
	<link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png" />
	<link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png" />
	<link rel="apple-touch-icon" href="/icon-180.png" />
	<title>napster</title>
</svelte:head>

<nav class="mx-auto flex max-w-3xl items-center gap-6 px-5 pt-6 text-sm">
	<a href="/" class="flex items-center gap-2 font-semibold">
		<img src="/icon-180.png" alt="" width="28" height="28" class="size-7" />
		napster
	</a>
	{#each links as link (link.href)}
		<a
			href={link.href}
			aria-current={page.url.pathname === link.href ? 'page' : undefined}
			class={[
				'underline-offset-4 hover:underline',
				page.url.pathname === link.href ? 'text-foreground underline' : 'text-muted-foreground'
			]}>{link.label}</a
		>
	{/each}
</nav>

{@render children()}
