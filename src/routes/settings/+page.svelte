<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as RadioGroup from '$lib/components/ui/radio-group/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { ART_SIZES, COOKIE_BROWSERS, MAX_CONCURRENCY } from '$lib/settings';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Writable deriveds: editable locally, reset to saved values whenever `data` reloads.
	let libraryDir = $derived(data.settings.libraryDir);
	let concurrency = $derived(data.settings.concurrency);
	let owner = $derived(data.settings.owner ? String(data.settings.owner.uid) : 'auto');
	let existingFiles = $derived<string>(data.settings.existingFiles);
	let artSize = $derived(String(data.settings.artSize));

	let saving = $state(false);
	let justSaved = $state(false);

	const existingOptions = [
		{ value: 'skip', label: 'Skip it', hint: 'Keeps the file already in the library.' },
		{ value: 'overwrite', label: 'Replace it', hint: 'Downloads again and overwrites.' },
		{ value: 'keep-both', label: 'Keep both', hint: 'Saves the new one as “Title (2).m4a”.' }
	];

	const artLabels: Record<number, string> = {
		500: '500 × 500 (saves space)',
		1000: '1000 × 1000 (best)'
	};

	const ownerLabel = $derived.by(() => {
		if (owner === 'auto') return 'Same as the music folder';
		const u = data.users.find((u) => String(u.uid) === owner);
		return u ? `${u.name} (${u.uid}:${u.gid})` : 'Pick a user';
	});

	const errors = $derived(form && 'errors' in form ? form.errors : undefined);

	let cookiesBusy = $state(false);
	const cookiesError = $derived(form && 'cookiesError' in form ? form.cookiesError : undefined);
	const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	let browser = $derived<string>(data.settings.cookieBrowser);
	let profile = $derived(data.settings.cookieProfile);
	let autoRefresh = $derived(data.settings.cookieAutoRefresh);
	let browserBusy = $state(false);
	const browserError = $derived(form && 'browserError' in form ? form.browserError : undefined);
	const browserNames: Record<string, string> = {
		'': 'Don’t read from a browser',
		firefox: 'Firefox',
		chrome: 'Chrome',
		brave: 'Brave',
		edge: 'Edge',
		chromium: 'Chromium',
		opera: 'Opera',
		vivaldi: 'Vivaldi',
		safari: 'Safari'
	};

	const cookiesExpired = $derived(!!data.cookies.expiresAt && data.cookies.expiresAt < Date.now());
</script>

<main class="mx-auto flex min-h-screen max-w-2xl flex-col gap-10 px-5 py-10">
	<header>
		<h1 class="text-4xl font-semibold tracking-tight">Settings</h1>
	</header>

	<form
		method="POST"
		action="?/save"
		class="flex flex-col gap-8"
		use:enhance={() => {
			saving = true;
			justSaved = false;
			return async ({ result, update }) => {
				await update({ reset: false });
				saving = false;
				justSaved = result.type === 'success';
			};
		}}
	>
		<div class="flex flex-col gap-2">
			<Label for="libraryDir">Music folder</Label>
			<Input id="libraryDir" name="libraryDir" bind:value={libraryDir} autocomplete="off" spellcheck={false} />
			<p class="text-sm text-muted-foreground">
				Path inside the container. In Docker, /music is the MUSIC_DIR folder set in .env.
			</p>
			{#if errors?.libraryDir}
				<p class="text-sm text-destructive">{errors.libraryDir}</p>
			{:else if data.libraryError}
				<p class="text-sm text-amber-600 dark:text-amber-400">{data.libraryError}</p>
			{/if}
		</div>

		<div class="flex flex-col gap-2">
			<Label for="owner">File owner</Label>
			<Select.Root type="single" bind:value={owner}>
				<Select.Trigger id="owner" class="w-full sm:w-80">{ownerLabel}</Select.Trigger>
				<Select.Content>
					<Select.Item value="auto" label="Same as the music folder">Same as the music folder</Select.Item>
					{#each data.users as u (u.uid)}
						<Select.Item value={String(u.uid)} label={u.name}>
							{u.name} ({u.uid}:{u.gid}, group {u.group})
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<input type="hidden" name="owner" value={owner} />
			<p class="text-sm text-muted-foreground">New folders and songs are owned by this user and their primary group.</p>
			{#if errors?.owner}<p class="text-sm text-destructive">{errors.owner}</p>{/if}
		</div>

		<fieldset class="flex flex-col gap-3">
			<legend class="mb-3 text-sm font-medium">When a song is already in the library</legend>
			<RadioGroup.Root bind:value={existingFiles} class="flex flex-col gap-3">
				{#each existingOptions as opt (opt.value)}
					<div class="flex items-start gap-3">
						<RadioGroup.Item value={opt.value} id={`existing-${opt.value}`} class="mt-0.5" />
						<Label for={`existing-${opt.value}`} class="flex flex-col items-start gap-0.5 font-normal">
							<span>{opt.label}</span>
							<span class="text-sm text-muted-foreground">{opt.hint}</span>
						</Label>
					</div>
				{/each}
			</RadioGroup.Root>
			<input type="hidden" name="existingFiles" value={existingFiles} />
			{#if errors?.existingFiles}<p class="text-sm text-destructive">{errors.existingFiles}</p>{/if}
		</fieldset>

		<div class="flex flex-col gap-2">
			<Label for="artSize">Album art size</Label>
			<Select.Root type="single" bind:value={artSize}>
				<Select.Trigger id="artSize" class="w-full sm:w-80">{artLabels[Number(artSize)]}</Select.Trigger>
				<Select.Content>
					{#each ART_SIZES as size (size)}
						<Select.Item value={String(size)} label={artLabels[size]}>{artLabels[size]}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<input type="hidden" name="artSize" value={artSize} />
			<p class="text-sm text-muted-foreground">
				Covers come from Deezer. When Deezer has none, the YouTube thumbnail (or the existing cover, when re-tagging) is cropped square instead.
			</p>
			{#if errors?.artSize}<p class="text-sm text-destructive">{errors.artSize}</p>{/if}
		</div>



		<div class="flex flex-col gap-2">
			<Label for="concurrency">Songs downloaded at the same time</Label>
			<Input id="concurrency" name="concurrency" type="number" min={1} max={MAX_CONCURRENCY} bind:value={concurrency} class="w-24" />
			{#if errors?.concurrency}<p class="text-sm text-destructive">{errors.concurrency}</p>{/if}
		</div>

		<div class="flex items-center gap-4 border-t pt-6">
			<Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
			{#if justSaved}
				<p class="text-sm text-muted-foreground" role="status">Saved. New downloads use these settings.</p>
			{/if}
		</div>
	</form>
	<section class="flex flex-col gap-4 border-t pt-8" aria-labelledby="cookies-heading">
		<div class="flex flex-col gap-1">
			<h2 id="cookies-heading" class="text-xl font-semibold tracking-tight">YouTube cookies</h2>
			<p class="text-sm text-muted-foreground">
				Downloads run as your signed-in YouTube account, which stops most HTTP 403 errors.
			</p>
		</div>

		{#if data.cookies.present}
			<div class="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2 text-sm">
				<p>
					{#if data.cookies.youtubeCookies === 0}
						<span class="text-destructive">The saved file is unreadable. Upload a new one.</span>
					{:else}
						Saved {data.cookies.savedAt ? dateFormat.format(data.cookies.savedAt) : ''}.
						{#if cookiesExpired}
							<span class="text-destructive">They have expired; export new ones.</span>
						{:else if data.cookies.expiresAt}
							Sign-in cookies expire {dateFormat.format(data.cookies.expiresAt)}.
						{/if}
					{/if}
				</p>
				<form method="POST" action="?/removeCookies" use:enhance>
					<Button type="submit" size="sm" variant="ghost">Remove cookies</Button>
				</form>
			</div>
		{:else}
			<p class="text-sm text-amber-600 dark:text-amber-400">No cookies saved. Some downloads may fail with HTTP 403.</p>
		{/if}

		<form
			method="POST"
			action="?/cookiesFromBrowser"
			class="flex flex-col gap-4 rounded-md border px-4 py-4"
			use:enhance={() => {
				browserBusy = true;
				return async ({ update }) => {
					await update({ reset: false });
					browserBusy = false;
				};
			}}
		>
			<div class="flex flex-col gap-1">
				<h3 class="font-medium">Read them from a browser</h3>
				<p class="text-sm text-muted-foreground">
					Takes the signed-in YouTube session straight from your browser, like
					<span class="font-mono">yt-dlp --cookies-from-browser</span>. Only YouTube cookies are kept.
					This only works when napster runs on the same computer as the browser. For the server, run
					<span class="font-mono">scripts/sync-cookies.sh</span> on your Mac instead.
				</p>
			</div>

			<div class="flex flex-wrap gap-4">
				<div class="flex flex-col gap-2">
					<Label for="browser">Browser</Label>
					<Select.Root type="single" bind:value={browser}>
						<Select.Trigger id="browser" class="w-56">{browserNames[browser]}</Select.Trigger>
						<Select.Content>
							<Select.Item value="" label={browserNames['']}>{browserNames['']}</Select.Item>
							{#each COOKIE_BROWSERS as b (b)}
								<Select.Item value={b} label={browserNames[b]}>{browserNames[b]}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					<input type="hidden" name="browser" value={browser} />
				</div>
				<div class="flex flex-col gap-2">
					<Label for="profile">Profile (optional)</Label>
					<Input id="profile" name="profile" bind:value={profile} placeholder="Default profile" class="w-56" disabled={!browser} />
				</div>
			</div>

			<div class="flex items-start justify-between gap-6">
				<div class="flex flex-col gap-1">
					<Label for="autoRefresh">Refresh before every download</Label>
					<p class="text-sm text-muted-foreground">
						Reads fresh cookies each time, so they never go stale. If it fails, the saved cookies are used.
					</p>
				</div>
				<Switch id="autoRefresh" bind:checked={autoRefresh} disabled={!browser} />
				<input type="hidden" name="autoRefresh" value={String(autoRefresh)} />
			</div>

			<p class="text-xs text-muted-foreground">
				On macOS, Chrome, Brave, Edge, Opera and Vivaldi ask for Keychain access the first time: choose
				Always Allow. Safari needs Full Disk Access for the app running napster (System Settings, Privacy
				&amp; Security). Firefox needs neither.
			</p>

			{#if browserError}<p class="text-sm text-destructive" role="alert">{browserError}</p>{/if}
			{#if form && 'browserImported' in form}
				<p class="text-sm text-muted-foreground" role="status">
					{form.browserImported ? 'Cookies imported and saved.' : 'Browser import turned off.'}
				</p>
			{/if}
			<div>
				<Button type="submit" disabled={browserBusy}>
					{browserBusy ? 'Reading cookies…' : browser ? 'Import now and save' : 'Save'}
				</Button>
			</div>
		</form>

		<details class="rounded-md border px-4 py-3 text-sm">
			<summary class="cursor-pointer font-medium">Or export them by hand</summary>
			<ol class="mt-3 flex list-decimal flex-col gap-2 pl-5 text-muted-foreground">
				<li>
					Use a spare Google account if you can. YouTube can restrict accounts it sees downloading
					with yt-dlp.
				</li>
				<li>
					Install a cookie exporter: <span class="text-foreground">Get cookies.txt LOCALLY</span> for
					Chrome, or <span class="text-foreground">cookies.txt</span> for Firefox. Avoid the similarly
					named “Get cookies.txt” (without LOCALLY); it was removed for sending cookies to a third party.
				</li>
				<li>Open a private (incognito) window and allow the extension to run there.</li>
				<li>Sign in at music.youtube.com.</li>
				<li>
					With the music.youtube.com tab open, click the extension and export the cookies for the
					current site. You get a <span class="font-mono">cookies.txt</span> file.
				</li>
				<li>
					Close the private window without signing out. Using that session in a browser again makes
					YouTube replace the cookies and the file stops working.
				</li>
				<li>Upload the file below. When downloads start failing again, repeat these steps.</li>
			</ol>
		</details>

		<form
			method="POST"
			action="?/cookies"
			enctype="multipart/form-data"
			class="flex flex-col gap-3"
			use:enhance={() => {
				cookiesBusy = true;
				return async ({ update }) => {
					await update();
					cookiesBusy = false;
				};
			}}
		>
			<div class="flex flex-col gap-2">
				<Label for="cookiesFile">cookies.txt file</Label>
				<Input id="cookiesFile" name="cookiesFile" type="file" accept=".txt,text/plain" />
			</div>
			<div class="flex flex-col gap-2">
				<Label for="cookiesText">Or paste its contents</Label>
				<Textarea
					id="cookiesText"
					name="cookiesText"
					rows={4}
					spellcheck={false}
					autocomplete="off"
					class="font-mono text-xs"
					placeholder="# Netscape HTTP Cookie File"
				/>
			</div>
			{#if cookiesError}<p class="text-sm text-destructive" role="alert">{cookiesError}</p>{/if}
			{#if form && 'cookiesSaved' in form}<p class="text-sm text-muted-foreground" role="status">Cookies saved. New downloads use them.</p>{/if}
			<div>
				<Button type="submit" disabled={cookiesBusy}>{cookiesBusy ? 'Saving…' : 'Save cookies'}</Button>
			</div>
		</form>
	</section>
</main>
