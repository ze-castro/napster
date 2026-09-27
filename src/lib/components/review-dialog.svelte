<script lang="ts">
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as RadioGroup from '$lib/components/ui/radio-group/index.js';
	import type {
		AlbumTagsInput,
		CoverChoice,
		DeezerAlbumResult,
		DeezerTrackResult,
		Proposal,
		ResolveInput,
		ReviewDetail,
		ReviewTrack,
		TrackTagsInput
	} from '$lib/types';

	let {
		reviewId,
		open = $bindable(false),
		onfinished
	}: { reviewId: string | null; open?: boolean; onfinished?: () => void } = $props();

	// ---------------------------------------------------------------- loading

	let detail = $state<ReviewDetail | null>(null);
	let loadError = $state('');

	/** The editable form. Featured artists are edited as comma-separated text. */
	let album = $state<AlbumTagsInput>({ album: '', albumArtist: '' });
	let tracks = $state<(ReviewTrack & { featuredText: string })[]>([]);
	let deezerAlbumId = $state<number | undefined>(undefined);

	/** The Deezer result shown next to "yours" in the comparison. */
	let compared = $state<Proposal | undefined>(undefined);

	type CoverType = CoverChoice['type'];
	let coverType = $state<CoverType>('upload');
	let deezerCoverUrl = $state<string | undefined>(undefined);
	let coverUrl = $state('');
	let coverFile = $state<File | null>(null);
	let coverPreview = $state<string | undefined>(undefined);

	let saving = $state(false);
	let saveError = $state('');

	function fillFromMine(d: ReviewDetail) {
		const { tracks: mine, ...fields } = d.current;
		album = { ...fields };
		tracks = mine.map((t) => ({ ...t, featuredText: t.featured.join(', ') }));
		deezerAlbumId = undefined;
		deezerCoverUrl = undefined;
		coverType = d.currentCover ? 'current' : 'upload';
	}

	$effect(() => {
		const id = reviewId;
		if (!open || !id) return;
		detail = null;
		loadError = '';
		saveError = '';
		results = [];
		searchError = '';
		coverUrl = '';
		coverFile = null;
		const controller = new AbortController();
		fetch(`/api/reviews/${encodeURIComponent(id)}`, { signal: controller.signal })
			.then(async (res) => {
				if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { message?: string } | null)?.message);
				const d = (await res.json()) as ReviewDetail;
				detail = d;
				compared = d.candidate;
				query = d.query;
				searchType = d.current.tracks.length === 1 ? 'track' : 'album';
				fillFromMine(d);
			})
			.catch((err: Error) => {
				if (err.name !== 'AbortError') loadError = err.message || 'Could not load this review.';
			});
		return () => controller.abort();
	});

	// ---------------------------------------------------------------- comparing and applying Deezer data

	function applyProposal(p: Proposal) {
		album = { ...p.album };
		for (const t of tracks) {
			const theirs = p.tracks.find((x) => x.key === t.key);
			if (!theirs) continue;
			t.title = theirs.title;
			t.artist = theirs.artist;
			t.featured = theirs.featured;
			t.featuredText = theirs.featured.join(', ');
			t.trackNumber = theirs.trackNumber;
			t.discNumber = theirs.discNumber;
		}
		deezerAlbumId = p.deezerAlbumId;
		deezerCoverUrl = p.coverUrl;
		if (p.coverUrl) coverType = 'deezer';
	}

	const same = (a: unknown, b: unknown) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
	const songLine = (t: TrackTagsInput | undefined) =>
		t ? `${t.trackNumber ? `${t.trackNumber}. ` : ''}${t.title}${t.featured.length ? ` (ft. ${t.featured.join(', ')})` : ''} · ${t.artist}` : '';

	// ---------------------------------------------------------------- Deezer search

	let query = $state('');
	let searchType = $state<'album' | 'track'>('album');
	let results = $state<(DeezerAlbumResult | DeezerTrackResult)[]>([]);
	let searching = $state(false);
	let searchError = $state('');
	let picking = $state<number | null>(null);

	async function search(event?: SubmitEvent) {
		event?.preventDefault();
		if (!query.trim()) return;
		searching = true;
		searchError = '';
		try {
			const res = await fetch(`/api/deezer/search?q=${encodeURIComponent(query)}&type=${searchType}`);
			if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { message?: string } | null)?.message);
			results = (await res.json()) as (DeezerAlbumResult | DeezerTrackResult)[];
			if (!results.length) searchError = 'Nothing found. Try fewer words or the other tab.';
		} catch (err) {
			searchError = (err as Error).message || 'Search failed.';
		} finally {
			searching = false;
		}
	}

	async function pick(r: DeezerAlbumResult | DeezerTrackResult) {
		if (!detail) return;
		picking = r.id;
		searchError = '';
		const params = 'albumId' in r ? `track=${r.id}&album=${r.albumId}` : `album=${r.id}`;
		try {
			const res = await fetch(`/api/reviews/${encodeURIComponent(detail.id)}/proposal?${params}`);
			if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { message?: string } | null)?.message);
			compared = (await res.json()) as Proposal;
		} catch (err) {
			searchError = (err as Error).message || 'Could not load that from Deezer.';
		} finally {
			picking = null;
		}
	}

	// ---------------------------------------------------------------- cover

	$effect(() => {
		// Local preview for uploads; revoked when replaced.
		if (coverType !== 'upload' || !coverFile) return;
		const url = URL.createObjectURL(coverFile);
		coverPreview = url;
		return () => URL.revokeObjectURL(url);
	});

	const previewSrc = $derived.by(() => {
		if (coverType === 'deezer') return deezerCoverUrl;
		if (coverType === 'current' && detail) return `/api/reviews/${encodeURIComponent(detail.id)}/cover`;
		if (coverType === 'url') return /^https?:\/\//i.test(coverUrl) ? coverUrl : undefined;
		return coverFile ? coverPreview : undefined;
	});

	// ---------------------------------------------------------------- save / discard

	function problems(): string | undefined {
		if (!album.album.trim()) return 'Album is required.';
		if (!album.albumArtist.trim()) return 'Album artist is required.';
		if (album.year && !/^\d{4}$/.test(album.year.trim())) return 'Year must be four digits, like 2011.';
		if (tracks.some((t) => !t.title.trim() || !t.artist.trim())) return 'Every song needs a title and an artist.';
		if (coverType === 'deezer' && !deezerCoverUrl) return 'This Deezer album has no cover; pick another option.';
		if (coverType === 'url' && !/^https?:\/\//i.test(coverUrl.trim())) return 'The cover URL must start with https://.';
		if (coverType === 'upload' && !coverFile) return 'Choose an image to upload.';
		return undefined;
	}

	async function save() {
		if (!detail) return;
		saveError = problems() ?? '';
		if (saveError) return;
		saving = true;

		const cover: CoverChoice =
			coverType === 'deezer'
				? { type: 'deezer', url: deezerCoverUrl! }
				: coverType === 'url'
					? { type: 'url', url: coverUrl.trim() }
					: { type: coverType };
		const input: ResolveInput = {
			album: { ...album, year: album.year?.trim() || undefined, genre: album.genre?.trim() || undefined },
			tracks: tracks.map((t) => ({
				key: t.key,
				title: t.title,
				artist: t.artist,
				featured: t.featuredText
					.split(',')
					.map((f) => f.trim())
					.filter(Boolean),
				trackNumber: t.trackNumber ? Number(t.trackNumber) : undefined,
				discNumber: t.discNumber ? Number(t.discNumber) : undefined
			})),
			cover,
			deezerAlbumId
		};
		const form = new FormData();
		form.set('data', JSON.stringify(input));
		if (coverType === 'upload' && coverFile) form.set('cover', coverFile);

		try {
			const res = await fetch(`/api/reviews/${encodeURIComponent(detail.id)}/resolve`, { method: 'POST', body: form });
			if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { message?: string } | null)?.message);
			open = false;
			onfinished?.();
		} catch (err) {
			saveError = (err as Error).message || 'Saving failed.';
		} finally {
			saving = false;
		}
	}

	async function discard() {
		if (!detail) return;
		const question =
			detail.kind === 'download'
				? 'Delete the downloaded songs? They were not added to the library.'
				: 'Leave these files as they are? Nothing will be changed.';
		if (!confirm(question)) return;
		const res = await fetch(`/api/reviews/${encodeURIComponent(detail.id)}/discard`, { method: 'POST' });
		if (res.ok) {
			open = false;
			onfinished?.();
		} else saveError = ((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? 'Could not discard.';
	}

	const reasonText = $derived(
		detail?.reason === 'close-match'
			? 'Deezer found something close, but not a sure match.'
			: detail?.reason === 'edit'
				? 'Edit the tags, or search Deezer to fill them in.'
				: 'Deezer has no confident match.'
	);
	const duration = (sec?: number) =>
		sec ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : '';
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
		<Dialog.Header>
			<Dialog.Title>{detail?.title ?? 'Loading…'}</Dialog.Title>
			<Dialog.Description>
				{reasonText}
				{#if detail?.note}<span class="block text-amber-700 dark:text-amber-400">{detail.note}</span>{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if loadError}
			<p class="text-sm text-destructive" role="alert">{loadError}</p>
		{:else if detail}
			{#if detail.missing?.length}
				<div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" role="alert">
					{detail.missing.length === detail.current.tracks.length
						? 'These files were moved or deleted after this review was created (probably saved through another review), so there is nothing to save here.'
						: `${detail.missing.join(', ')} ${detail.missing.length === 1 ? 'was' : 'were'} moved or deleted after this review was created.`}
					Use <strong>{detail.kind === 'download' ? 'Discard songs' : 'Leave unchanged'}</strong> to close it{detail.missing.length === detail.current.tracks.length ? '' : ', then re-tag the folder again'}.
				</div>
			{/if}
			<!-- Compare: yours vs Deezer -->
			{#if compared}
				{@const p = compared}
				<section class="flex flex-col gap-3 rounded-md border p-3" aria-labelledby="compare-heading">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<h3 id="compare-heading" class="font-medium">Compare</h3>
						<div class="flex items-center gap-2">
							<a class="text-sm underline underline-offset-4" href={p.deezerUrl} target="_blank" rel="noreferrer">Open on Deezer</a>
							<Button size="sm" onclick={() => applyProposal(p)}>Use Deezer's tags</Button>
						</div>
					</div>
					<p class="text-sm text-muted-foreground">
						{p.matched} of {p.total} of your songs were found on this album. Songs not found keep your title and artist.
					</p>
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="text-left text-muted-foreground">
									<th class="w-28 py-1 pr-3 font-normal"></th>
									<th class="py-1 pr-3 font-normal">Yours</th>
									<th class="py-1 font-normal">Deezer</th>
								</tr>
							</thead>
							<tbody class="align-top">
								{#each [['Album', detail.current.album, p.album.album], ['Album artist', detail.current.albumArtist, p.album.albumArtist], ['Year', detail.current.year, p.album.year], ['Genre', detail.current.genre, p.album.genre]] as [label, mine, theirs] (label)}
									<tr class="border-t">
										<th class="py-1.5 pr-3 font-normal text-muted-foreground">{label}</th>
										<td class="py-1.5 pr-3">{mine || '—'}</td>
										<td class={['py-1.5', !same(mine, theirs) && 'text-amber-700 dark:text-amber-400']}>{theirs || '—'}</td>
									</tr>
								{/each}
								<tr class="border-t">
									<th class="py-1.5 pr-3 font-normal text-muted-foreground">Cover</th>
									<td class="py-1.5 pr-3">
										{#if detail.currentCover}
											<img src={`/api/reviews/${encodeURIComponent(detail.id)}/cover`} alt="Your cover" class="size-16 rounded object-cover" />
										{:else}—{/if}
									</td>
									<td class="py-1.5">
										{#if p.coverUrl}<img src={p.coverUrl} alt="Deezer cover" class="size-16 rounded object-cover" />{:else}—{/if}
									</td>
								</tr>
								{#each detail.current.tracks as mine (mine.key)}
									{@const theirs = p.tracks.find((t) => t.key === mine.key)}
									<tr class="border-t">
										<th class="py-1.5 pr-3 font-normal text-muted-foreground">Song</th>
										<td class="py-1.5 pr-3">{songLine(mine)}</td>
										<td class={['py-1.5', songLine(mine) !== songLine(theirs) && 'text-amber-700 dark:text-amber-400']}>
											{songLine(theirs)}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</section>
			{/if}

			<!-- Search Deezer -->
			<section class="flex flex-col gap-3" aria-labelledby="search-heading">
				<h3 id="search-heading" class="font-medium">Search Deezer</h3>
				<form class="flex flex-wrap gap-2" onsubmit={search}>
					<div class="flex gap-1" role="group" aria-label="Search for">
						<Button size="sm" variant={searchType === 'album' ? 'secondary' : 'ghost'} aria-pressed={searchType === 'album'} onclick={() => (searchType = 'album')}>Albums</Button>
						<Button size="sm" variant={searchType === 'track' ? 'secondary' : 'ghost'} aria-pressed={searchType === 'track'} onclick={() => (searchType = 'track')}>Songs</Button>
					</div>
					<Input type="search" bind:value={query} placeholder="Artist and album or song" class="min-w-48 flex-1" aria-label="Search Deezer" />
					<Button type="submit" variant="outline" disabled={searching || !query.trim()}>{searching ? 'Searching…' : 'Search'}</Button>
				</form>
				{#if searchError}<p class="text-sm text-muted-foreground">{searchError}</p>{/if}
				{#if results.length}
					<ul class="flex max-h-64 flex-col divide-y overflow-y-auto rounded-md border">
						{#each results as r (r.id)}
							<li>
								<button
									class={['flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50', compared && (compared.deezerAlbumId === r.id || ('albumId' in r && compared.deezerAlbumId === r.albumId)) && 'bg-muted/60']}
									disabled={picking !== null}
									onclick={() => pick(r)}
								>
									{#if r.cover}
										<img src={r.cover} alt="" class="size-10 shrink-0 rounded object-cover" loading="lazy" />
									{:else}
										<span class="size-10 shrink-0 rounded bg-muted"></span>
									{/if}
									<span class="flex min-w-0 flex-1 flex-col">
										<span class="truncate font-medium">{r.title}</span>
										<span class="truncate text-muted-foreground">
											{r.artist}{'albumId' in r ? `, ${r.album}` : ''}
										</span>
									</span>
									<span class="shrink-0 text-xs text-muted-foreground">
										{#if picking === r.id}Loading…{:else if 'albumId' in r}{duration(r.durationSec)}{:else}{r.type}, {r.tracks} {r.tracks === 1 ? 'song' : 'songs'}{/if}
									</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<!-- The tags that will be written -->
			<section class="flex flex-col gap-4" aria-labelledby="tags-heading">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h3 id="tags-heading" class="font-medium">
						Tags to save
						{#if deezerAlbumId}<Badge variant="outline" class="ml-2">From Deezer</Badge>{/if}
					</h3>
					<Button size="sm" variant="ghost" onclick={() => detail && fillFromMine(detail)}>Reset to mine</Button>
				</div>

				<div class="grid gap-3 sm:grid-cols-2">
					<div class="flex flex-col gap-1.5">
						<Label for="rv-album">Album</Label>
						<Input id="rv-album" bind:value={album.album} />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="rv-album-artist">Album artist</Label>
						<Input id="rv-album-artist" bind:value={album.albumArtist} />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="rv-year">Year</Label>
						<Input id="rv-year" inputmode="numeric" maxlength={4} bind:value={album.year} placeholder="2011" />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="rv-genre">Genre</Label>
						<Input id="rv-genre" bind:value={album.genre} />
					</div>
				</div>

				<div class="flex flex-col gap-2">
					<p class="text-sm font-medium">Songs</p>
					<div class="hidden grid-cols-[3.5rem_3.5rem_1fr_1fr_1fr] gap-2 text-xs text-muted-foreground sm:grid">
						<span>No.</span><span>Disc</span><span>Title</span><span>Artist</span><span>Featured (comma-separated)</span>
					</div>
					{#each tracks as t, i (t.key)}
						<div class="flex flex-col gap-1 rounded-md border p-2 sm:border-0 sm:p-0">
							<p class="truncate text-xs text-muted-foreground" title={t.file}>
								{t.file}{t.durationSec ? `, ${duration(t.durationSec)}` : ''}
							</p>
							<div class="grid grid-cols-2 gap-2 sm:grid-cols-[3.5rem_3.5rem_1fr_1fr_1fr]">
								<Input type="number" min={1} max={999} bind:value={t.trackNumber} aria-label={`Track number, song ${i + 1}`} placeholder="#" />
								<Input type="number" min={1} max={99} bind:value={t.discNumber} aria-label={`Disc, song ${i + 1}`} placeholder="1" />
								<Input bind:value={t.title} aria-label={`Title, song ${i + 1}`} placeholder="Title" class="col-span-2 sm:col-span-1" />
								<Input bind:value={t.artist} aria-label={`Artist, song ${i + 1}`} placeholder="Artist" class="col-span-2 sm:col-span-1" />
								<Input bind:value={t.featuredText} aria-label={`Featured artists, song ${i + 1}`} placeholder="Featured" class="col-span-2 sm:col-span-1" />
							</div>
						</div>
					{/each}
				</div>

				<div class="flex flex-col gap-3 sm:flex-row sm:items-start">
					{#if previewSrc}
						<img src={previewSrc} alt="Cover preview" class="size-28 shrink-0 rounded-md border object-cover" />
					{:else}
						<div class="flex size-28 shrink-0 items-center justify-center rounded-md border bg-muted text-center text-xs text-muted-foreground">No cover</div>
					{/if}
					<div class="flex flex-1 flex-col gap-2">
						<p class="text-sm font-medium">Cover</p>
						<RadioGroup.Root bind:value={coverType} class="flex flex-col gap-2">
							{#if deezerCoverUrl}
								<div class="flex items-center gap-2">
									<RadioGroup.Item value="deezer" id="cv-deezer" />
									<Label for="cv-deezer" class="font-normal">Deezer's cover</Label>
								</div>
							{/if}
							{#if detail.currentCover}
								<div class="flex items-center gap-2">
									<RadioGroup.Item value="current" id="cv-current" />
									<Label for="cv-current" class="font-normal">
										{detail.currentCover === 'youtube' ? 'YouTube thumbnail' : 'Current cover'}
									</Label>
								</div>
							{/if}
							<div class="flex flex-wrap items-center gap-2">
								<RadioGroup.Item value="upload" id="cv-upload" />
								<Label for="cv-upload" class="font-normal">Upload an image</Label>
								{#if coverType === 'upload'}
									<Input
										type="file"
										accept="image/*"
										class="max-w-64"
										aria-label="Cover image file"
										onchange={(e) => (coverFile = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)}
									/>
								{/if}
							</div>
							<div class="flex flex-wrap items-center gap-2">
								<RadioGroup.Item value="url" id="cv-url" />
								<Label for="cv-url" class="font-normal">Image URL</Label>
								{#if coverType === 'url'}
									<Input type="url" bind:value={coverUrl} placeholder="https://…" class="max-w-80" aria-label="Cover image URL" />
								{/if}
							</div>
						</RadioGroup.Root>
						<p class="text-xs text-muted-foreground">Any image is cropped to a square automatically.</p>
					</div>
				</div>
			</section>

			{#if saveError}<p class="text-sm text-destructive" role="alert">{saveError}</p>{/if}

			<Dialog.Footer class="flex-row flex-wrap justify-between gap-2 sm:justify-between">
				<Button variant="ghost" class="text-destructive" disabled={saving} onclick={discard}>
					{detail.kind === 'download' ? 'Discard songs' : 'Leave unchanged'}
				</Button>
				<Button disabled={saving || !!detail.missing?.length} onclick={save}>{saving ? 'Saving…' : 'Save to library'}</Button>
			</Dialog.Footer>
		{:else}
			<p class="text-sm text-muted-foreground">Loading…</p>
		{/if}
	</Dialog.Content>
</Dialog.Root>
