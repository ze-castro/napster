<script lang="ts">
	import '../app.css';
	import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Library from '@lucide/svelte/icons/library';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Moon from '@lucide/svelte/icons/moon';
	import Settings from '@lucide/svelte/icons/settings';
	import Sun from '@lucide/svelte/icons/sun';
	import WifiOff from '@lucide/svelte/icons/wifi-off';
	import { page } from '$app/state';
	import { provideLive } from '$lib/jobs.svelte';
	import { cycleTheme, theme, watchSystemTheme } from '$lib/theme.svelte';

	let { children } = $props();

	const live = provideLive();
	$effect(() => watchSystemTheme());

	const links = [
		{ href: '/', label: 'Downloads', icon: ArrowDownToLine },
		{ href: '/library', label: 'Library', icon: Library },
		{ href: '/review', label: 'Needs input', icon: Inbox },
		{ href: '/settings', label: 'Settings', icon: Settings }
	];

	const running = $derived(live.jobs.filter((j) => j.status === 'running' || j.status === 'resolving').length);
	const themeLabel = { system: 'Theme: follows your device', light: 'Theme: light', dark: 'Theme: dark' };

	// A dropped connection is only worth mentioning once it has lasted a moment.
	let offline = $state(false);
	$effect(() => {
		if (live.connected) {
			offline = false;
			return;
		}
		const timer = setTimeout(() => (offline = true), 2500);
		return () => clearTimeout(timer);
	});
</script>

<svelte:head>
	<title>{live.reviews.length ? `(${live.reviews.length}) napster` : 'napster'}</title>
</svelte:head>

<header class="sticky top-0 z-30 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
	<div class="mx-auto flex h-14 max-w-3xl items-center gap-1 px-3 sm:px-5">
		<a href="/" class="mr-1 flex shrink-0 items-center gap-2 rounded-md pr-2 font-semibold sm:mr-3">
			<img src="/icon-180.png" alt="" width="28" height="28" class="size-7 rounded-md" />
			<span class="hidden sm:inline">napster</span>
		</a>

		<nav class="flex items-center gap-0.5" aria-label="Main">
			{#each links as link (link.href)}
				{@const active = page.url.pathname === link.href}
				<a
					href={link.href}
					aria-current={active ? 'page' : undefined}
					aria-label={link.label}
					class={[
						'relative inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors',
						'focus-visible:outline-2 focus-visible:outline-ring',
						active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
					]}
				>
					<link.icon class="size-4 shrink-0" aria-hidden="true" />
					<span class="hidden sm:inline">{link.label}</span>
					{#if link.href === '/review' && live.reviews.length}
						<span
							class="rounded-full bg-amber-500 px-1.5 text-xs leading-5 font-semibold text-white tabular-nums"
							aria-label="{live.reviews.length} waiting"
						>
							{live.reviews.length}
						</span>
					{:else if link.href === '/' && running}
						<span class="size-1.5 animate-pulse rounded-full bg-sky-500" aria-label="{running} running"></span>
					{/if}
				</a>
			{/each}
		</nav>

		<div class="ml-auto flex items-center gap-1">
			{#if offline}
				<span
					class="flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
					role="status"
				>
					<WifiOff class="size-3.5" aria-hidden="true" />
					<span class="hidden sm:inline">Reconnecting…</span>
				</span>
			{/if}
			<button
				type="button"
				onclick={cycleTheme}
				class="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
				aria-label={themeLabel[theme.value]}
				title={themeLabel[theme.value]}
			>
				{#if theme.value === 'light'}
					<Sun class="size-4" />
				{:else if theme.value === 'dark'}
					<Moon class="size-4" />
				{:else}
					<Monitor class="size-4" />
				{/if}
			</button>
		</div>
	</div>
</header>

{@render children()}
