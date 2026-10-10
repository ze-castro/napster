<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { SvelteSet } from 'svelte/reactivity';
  import FolderOpen from '@lucide/svelte/icons/folder';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Search from '@lucide/svelte/icons/search';
  import FolderCover from '$lib/components/folder-cover.svelte';
  import JobList from '$lib/components/job-list.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import { useLive } from '$lib/jobs.svelte';
  import type { JobState, LibraryAlbum, LibraryTrack, TrackState } from '$lib/types';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const stream = useLive();
  const retags = $derived(stream.jobs.filter((j) => j.kind === 'retag' || j.kind === 'edit'));
  const runningCount = $derived(retags.filter((j) => j.status === 'running').length);

  let tab = $state('library');

  // ---------------------------------------------------------------- folders

  let albums = $state<LibraryAlbum[]>([]);
  let loading = $state(true);
  let listError = $state('');

  async function loadAlbums() {
    try {
      const res = await fetch('/api/library');
      if (res.ok) {
        albums = (await res.json()) as LibraryAlbum[];
        listError = '';
      } else {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        listError = body?.message ?? 'Could not read the music folder.';
      }
    } catch {
      listError = 'Could not reach the server.';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    loadAlbums();
  });

  // Folders move when a re-tag renames them: reload whenever a re-tag finishes.
  const finishedRetags = $derived(
    retags.filter((j) => j.status === 'done' || j.status === 'failed').length,
  );
  let seenFinished = -1;
  $effect(() => {
    const n = finishedRetags;
    if (seenFinished !== -1 && n > seenFinished) loadAlbums();
    seenFinished = n;
  });

  let query = $state('');
  let filter = $state<'all' | 'albums' | 'singles'>('all');

  /** Lowercase, no accents, so "beyonce" finds "Beyoncé". */
  const fold = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  /** "01. Song (ft. X)" → "Song (ft. X)" for display. */
  const songTitle = (file: string) => file.replace(/^(?:\d+-)?\d{1,3}\.\s*/, '');

  /** Folders whose path or any song name contains the search, plus which songs matched. */
  const shown = $derived.by(() => {
    const q = fold(query.trim());
    const out: { album: LibraryAlbum; songHits: string[] }[] = [];
    for (const a of albums) {
      if (filter === 'albums' && a.tracks < 2) continue;
      if (filter === 'singles' && a.tracks !== 1) continue;
      if (!q) {
        out.push({ album: a, songHits: [] });
        continue;
      }
      const songHits = a.songs.filter((s) => fold(s).includes(q)).map(songTitle);
      if (fold(a.path).includes(q) || songHits.length) out.push({ album: a, songHits });
    }
    return out;
  });
  const counts = $derived({
    all: albums.length,
    albums: albums.filter((a) => a.tracks > 1).length,
    singles: albums.filter((a) => a.tracks === 1).length,
  });

  type FolderStatus = 'running' | 'needs-input' | 'failed' | 'done';
  interface FolderState {
    job: JobState;
    status: FolderStatus;
    /** The review for this folder's own waiting song, not the job's first one. */
    reviewId?: string;
  }

  const UNSETTLED = new Set<TrackState['status']>(['queued', 'downloading', 'waiting', 'tagging']);

  /**
   * Latest re-tag state per folder, judged by that folder's own songs. One job can touch many
   * folders (a playlist folder handled as separate songs moves each song to its own folder),
   * so the job's overall status says nothing about a single folder.
   * A saved song belongs to the folder it moved to; any other song to the folder it's still in.
   */
  const folderState = $derived.by(() => {
    const map = new Map<string, FolderState>();
    for (const job of retags) {
      const byFolder = new Map<string, TrackState[]>();
      for (const t of job.tracks) {
        const folder = parentOf(t.path ?? t.key);
        if (folder) byFolder.set(folder, [...(byFolder.get(folder) ?? []), t]);
      }
      // Still reading the folder: no songs listed yet.
      if (job.folder && !byFolder.size && job.status === 'running') byFolder.set(job.folder, []);

      for (const [folder, tracks] of byFolder) {
        if (map.has(folder)) continue; // a newer job already decided this folder
        const waiting = tracks.find((t) => t.status === 'needs-input');
        const status: FolderStatus =
          job.status === 'running' && (!tracks.length || tracks.some((t) => UNSETTLED.has(t.status)))
            ? 'running'
            : waiting
              ? 'needs-input'
              : tracks.some((t) => t.status === 'failed')
                ? 'failed'
                : 'done';
        map.set(folder, { job, status, reviewId: waiting?.reviewId });
      }
    }
    return map;
  });

  const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');

  // ---------------------------------------------------------------- selection + re-tag

  const selected = new SvelteSet<string>();
  const allShownSelected = $derived(
    shown.length > 0 && shown.every(({ album }) => selected.has(album.path)),
  );

  function toggleAllShown(on: boolean) {
    for (const { album } of shown) on ? selected.add(album.path) : selected.delete(album.path);
  }

  let actionError = $state('');
  let starting = $state(false);

  let editing = $state(false);

  /** Opens the tag editor for a folder (on the Needs input page). */
  async function editTags(folder: string) {
    editing = true;
    actionError = '';
    const res = await fetch('/api/library/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder })
    });
    const body = (await res.json().catch(() => null)) as { reviewId?: string; message?: string } | null;
    editing = false;
    if (!res.ok || !body?.reviewId) {
      actionError = body?.message ?? 'Could not open the tag editor.';
      return;
    }
    sheetOpen = false;
    goto(`/review?id=${encodeURIComponent(body.reviewId)}`);
  }

  async function retag(folders: string[], mode: 'auto' | 'songs' = 'auto') {
    if (!folders.length) return;
    starting = true;
    actionError = '';
    const res = await fetch('/api/retag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folders, mode }),
    });
    const body = (await res.json().catch(() => null)) as {
      failed?: { folder: string; message: string }[];
      message?: string;
    } | null;
    if (body?.failed?.length)
      actionError = body.failed.map((f) => `${f.folder}: ${f.message}`).join(' ');
    else if (!res.ok) actionError = body?.message ?? 'Re-tag failed to start.';
    for (const f of folders) selected.delete(f);
    starting = false;
    setTimeout(() => invalidate('app:backups'), 3000);
  }

  // ---------------------------------------------------------------- details panel

  let sheetOpen = $state(false);
  let current = $state<LibraryAlbum | null>(null);
  let tracks = $state<LibraryTrack[]>([]);
  let tracksLoading = $state(false);

  async function openFolder(album: LibraryAlbum) {
    current = album;
    sheetOpen = true;
    tracksLoading = true;
    tracks = [];
    const res = await fetch(`/api/library/folder?path=${encodeURIComponent(album.path)}`);
    tracks = res.ok ? ((await res.json()) as LibraryTrack[]) : [];
    tracksLoading = false;
  }

  const currentState = $derived(current ? folderState.get(current.path) : undefined);
  const currentJob = $derived(currentState?.job);

  /** The songs of the last job that belong to the open folder (before or after moving). */
  const currentTracks = $derived(
    current && currentJob
      ? currentJob.tracks.filter(
          (t) => parentOf(t.key) === current!.path || (t.path && parentOf(t.path) === current!.path)
        )
      : []
  );

  // When a re-tag moves the open folder's own songs elsewhere and the folder is gone, follow them.
  $effect(() => {
    const job = currentJob;
    const folder = current;
    if (!folder || !job || job.status === 'running') return;
    if (albums.some((a) => a.path === folder.path)) return; // folder still exists: stay
    const moved = job.tracks.find((t) => parentOf(t.key) === folder.path && t.path)?.path;
    const next = moved && albums.find((a) => a.path === parentOf(moved));
    if (next) openFolder(next);
  });

  const duration = (sec?: number) =>
    sec ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : '';

  // ---------------------------------------------------------------- backups

  let busyBackup = $state<string | null>(null);
  let deletingAll = $state(false);

  async function backupAction(id: string, action: 'restore' | 'delete', label: string) {
    const question =
      action === 'restore'
        ? `Restore the original files and tags for “${label}”?`
        : `Delete the backup of “${label}”? The current files stay as they are.`;
    if (!confirm(question)) return;
    busyBackup = id;
    actionError = '';
    const res = await fetch(
      action === 'restore'
        ? `/api/backups/${encodeURIComponent(id)}/restore`
        : `/api/backups/${encodeURIComponent(id)}`,
      { method: action === 'restore' ? 'POST' : 'DELETE' },
    );
    if (!res.ok)
      actionError =
        ((await res.json().catch(() => null)) as { message?: string } | null)?.message ??
        'That did not work.';
    await invalidate('app:backups');
    if (action === 'restore') await loadAlbums();
    busyBackup = null;
  }

  async function deleteAll() {
    if (
      !confirm(
        `Delete all ${data.backups.length} backups? The current files stay as they are, but no re-tag can be undone afterwards.`,
      )
    )
      return;
    deletingAll = true;
    const res = await fetch('/api/backups', { method: 'DELETE' });
    if (!res.ok) actionError = 'Could not delete the backups.';
    await invalidate('app:backups');
    deletingAll = false;
  }

  const dateFormat = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
</script>

<main class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-5 sm:py-10">
  <PageHeader title="Library">
    Folders in <span class="font-mono text-[0.8125rem] break-all">{data.libraryDir}</span>. Re-tagging
    backs up the originals first, so it can always be undone.
  </PageHeader>

  {#if actionError}
    <p class="text-sm text-destructive" role="alert">{actionError}</p>
  {/if}

  <Tabs.Root bind:value={tab} class="flex flex-col gap-4">
    <Tabs.List class="self-start">
      <Tabs.Trigger value="library"
        >Folders <span class="ml-1 text-muted-foreground">{albums.length}</span></Tabs.Trigger
      >
      <Tabs.Trigger value="activity">
        Activity
        {#if runningCount}<span
            class="ml-1 size-2 animate-pulse rounded-full bg-sky-500"
            aria-label="{runningCount} running"
          ></span>{/if}
      </Tabs.Trigger>
      <Tabs.Trigger value="backups"
        >Backups <span class="ml-1 text-muted-foreground">{data.backups.length}</span></Tabs.Trigger
      >
    </Tabs.List>

    <Tabs.Content value="library" class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <div class="relative w-full sm:w-72">
          <Search
            class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            placeholder="Search artist, album or song"
            bind:value={query}
            autocomplete="off"
            class="pl-8"
            aria-label="Search folders"
          />
        </div>
        <div class="flex gap-1" role="group" aria-label="Show">
          {#each [['all', 'All'], ['albums', 'Albums'], ['singles', 'Singles']] as const as [value, label] (value)}
            <Button
              size="sm"
              variant={filter === value ? 'secondary' : 'ghost'}
              aria-pressed={filter === value}
              onclick={() => (filter = value)}
            >
              {label} <span class="text-muted-foreground">{counts[value]}</span>
            </Button>
          {/each}
        </div>
      </div>

      <div
        class={[
          'sticky top-16 z-10 flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 py-1.5 backdrop-blur transition-colors',
          selected.size ? 'border-primary/30 bg-background/95 shadow-sm' : 'bg-muted/60',
        ]}
      >
        <label class="flex items-center gap-2 text-sm">
          <Checkbox
            checked={allShownSelected}
            onCheckedChange={(v: boolean) => toggleAllShown(v)}
            disabled={!shown.length}
            aria-label="Select all shown"
          />
          {selected.size ? `${selected.size} selected` : 'Select all'}
        </label>
        {#if selected.size}
          <div class="flex items-center gap-2">
            <Button size="sm" variant="ghost" onclick={() => selected.clear()}>Clear</Button>
            <Button size="sm" disabled={starting} onclick={() => retag([...selected])}>
              {starting ? 'Starting…' : `Re-tag ${selected.size}`}
            </Button>
          </div>
        {/if}
      </div>

      {#if listError}
        <p class="text-sm text-destructive">{listError}</p>
      {:else if loading}
        <p class="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <LoaderCircle class="size-4 animate-spin" aria-hidden="true" /> Reading the music folder…
        </p>
      {:else if !shown.length}
        <div class="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
          <FolderOpen class="size-5 text-muted-foreground/60" aria-hidden="true" />
          <p class="text-sm text-muted-foreground">
            {albums.length
              ? 'Nothing matches that search.'
              : 'No folders with .m4a files yet. Downloads show up here.'}
          </p>
          {#if albums.length && (query || filter !== 'all')}
            <Button
              size="sm"
              variant="outline"
              onclick={() => {
                query = '';
                filter = 'all';
              }}>Show everything</Button
            >
          {/if}
        </div>
      {:else}
        <ul class="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
          {#each shown as { album, songHits } (album.path)}
            {@const folder = folderState.get(album.path)}
            <li
              class={[
                'flex items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/40',
                selected.has(album.path) && 'bg-muted/60',
              ]}
            >
              <Checkbox
                checked={selected.has(album.path)}
                onCheckedChange={(v: boolean) =>
                  v ? selected.add(album.path) : selected.delete(album.path)}
                aria-label={`Select ${album.path}`}
              />
              <button
                class="flex min-w-0 flex-1 items-center gap-3 text-left"
                onclick={() => openFolder(album)}
              >
                <FolderCover path={album.path} version={album.version} class="size-11 rounded-md" />
                <span class="flex min-w-0 flex-col">
                  <span class="truncate font-medium">{album.album}</span>
                  <span class="truncate text-sm text-muted-foreground"
                    >{album.artist || 'No artist folder'}</span
                  >
                  {#if songHits.length}
                    <span class="truncate text-xs text-sky-700 dark:text-sky-400">
                      {songHits.slice(0, 3).join(', ')}{songHits.length > 3
                        ? ` and ${songHits.length - 3} more`
                        : ''}
                    </span>
                  {/if}
                </span>
              </button>
              {#if folder?.status === 'running'}
                <span class="flex shrink-0 items-center gap-1 text-xs text-sky-600 dark:text-sky-400">
                  <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" /> Re-tagging
                </span>
              {:else if folder?.status === 'needs-input' && folder.reviewId}
                <a
                  class="shrink-0 text-xs text-amber-700 underline underline-offset-4 dark:text-amber-400"
                  href={`/review?id=${encodeURIComponent(folder.reviewId)}`}
                  >Needs input</a
                >
              {:else if folder?.status === 'failed'}
                <span class="shrink-0 text-xs text-destructive">Re-tag failed</span>
              {/if}
              <span class="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">
                {album.tracks === 1 ? 'Single' : `${album.tracks} songs`}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </Tabs.Content>

    <Tabs.Content value="activity">
      <JobList jobs={retags} kind="retag" title="Re-tags" empty="Re-tags and tag edits you start show up here." />
    </Tabs.Content>

    <Tabs.Content value="backups" class="flex flex-col gap-3">
      {#if data.backups.length}
        <div class="flex items-center justify-between gap-4">
          <p class="text-sm text-muted-foreground">
            Restoring puts the original files, names and folders back.
          </p>
          <Button
            size="sm"
            variant="ghost"
            class="text-destructive"
            disabled={deletingAll}
            onclick={deleteAll}
          >
            {deletingAll ? 'Deleting…' : 'Delete all'}
          </Button>
        </div>
        <ul class="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
          {#each data.backups as backup (backup.id)}
            <li class="flex items-center justify-between gap-4 px-3 py-2.5">
              <div class="min-w-0">
                <p class="truncate">{backup.label}</p>
                <p class="text-xs text-muted-foreground">
                  {dateFormat.format(backup.createdAt)}, {backup.files}
                  {backup.files === 1 ? 'file' : 'files'}
                </p>
              </div>
              <div class="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyBackup === backup.id}
                  onclick={() => backupAction(backup.id, 'restore', backup.label)}>Restore</Button
                >
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyBackup === backup.id}
                  onclick={() => backupAction(backup.id, 'delete', backup.label)}>Delete</Button
                >
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <div class="rounded-xl border border-dashed px-6 py-10 text-center">
          <p class="text-sm text-muted-foreground">No backups yet. Every re-tag makes one, so it can be undone.</p>
        </div>
      {/if}
    </Tabs.Content>
  </Tabs.Root>
</main>

<Sheet.Root bind:open={sheetOpen}>
  <Sheet.Content side="right" class="flex w-full flex-col gap-5 overflow-y-auto sm:max-w-lg">
    {#if current}
      <Sheet.Header class="flex flex-row items-center gap-4 text-left">
        <FolderCover path={current.path} version={current.version} class="size-24" />
        <div class="min-w-0">
          <Sheet.Title class="truncate">{current.album}</Sheet.Title>
          <Sheet.Description class="truncate">
            {current.artist || 'No artist folder'}, {current.tracks === 1
              ? '1 song'
              : `${current.tracks} songs`}
          </Sheet.Description>
        </div>
      </Sheet.Header>

      <div class="flex flex-wrap gap-2 px-4">
        <Button
          disabled={starting || currentJob?.status === 'running'}
          onclick={() => current && retag([current.path])}
        >
          {currentJob?.status === 'running' ? 'Re-tagging…' : 'Re-tag'}
        </Button>
        <Button
          variant="outline"
          disabled={editing || currentJob?.status === 'running'}
          onclick={() => current && editTags(current.path)}
        >
          {editing ? 'Opening…' : 'Edit tags'}
        </Button>
        {#if current.tracks > 1}
          <Button
            variant="outline"
            disabled={starting || currentJob?.status === 'running'}
            onclick={() => current && retag([current.path], 'songs')}
          >
            Re-tag as separate songs
          </Button>
        {/if}
        {#if currentJob}
          <Button
            variant="ghost"
            onclick={() => {
              tab = 'activity';
              sheetOpen = false;
            }}>See last re-tag</Button
          >
        {/if}
      </div>
      {#if current.tracks > 1}
        <p class="px-4 text-xs text-muted-foreground">
          Re-tag looks the folder up on Deezer as one album, unless it looks like a playlist. Use
          “separate songs” for playlists and mixes: each song gets its own album, cover and folder.
          Edit tags opens the editor with Deezer search, for fixing a wrong match by hand.
        </p>
      {/if}

      {#if currentState && currentState.status !== 'running' && currentTracks.length}
        <p class="px-4 text-sm text-muted-foreground">
          Last re-tag: {currentTracks.filter((t) => t.status === 'done').length} of {currentTracks.length}
          {currentTracks.length === 1 ? 'song' : 'songs'}
          {currentJob?.restored ? '(undone).' : 'updated.'}
          {#if currentState.status === 'needs-input' && currentState.reviewId}
            <a class="underline underline-offset-4" href={`/review?id=${encodeURIComponent(currentState.reviewId)}`}
              >Review the rest</a
            >
          {/if}
        </p>
      {/if}

      <div class="px-4 pb-6">
        {#if tracksLoading}
          <p class="text-sm text-muted-foreground">Reading tags…</p>
        {:else}
          <ol class="flex flex-col divide-y">
            {#each tracks as t (t.file)}
              <li class="flex items-baseline gap-3 py-2 text-sm">
                <span class="w-6 shrink-0 text-right tabular-nums text-muted-foreground"
                  >{t.track?.split('/')[0] ?? ''}</span
                >
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate">{t.title ?? t.file}</span>
                  <span class="truncate text-muted-foreground">
                    {t.artist ?? 'No artist'}{t.year ? `, ${t.year}` : ''}
                  </span>
                </span>
                <span class="shrink-0 tabular-nums text-muted-foreground"
                  >{duration(t.durationSec)}</span
                >
              </li>
            {/each}
          </ol>
          {#if tracks[0]}
            <p class="mt-3 text-xs text-muted-foreground">
              Album: {tracks[0].album ?? 'none'}. Album artist: {tracks[0].albumArtist ?? 'none'}.
            </p>
          {/if}
        {/if}
      </div>
    {/if}
  </Sheet.Content>
</Sheet.Root>
