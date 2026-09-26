# napster

Paste a YouTube Music song, album or playlist link; it downloads the best AAC stream with yt-dlp,
tags it (MusicBrainz first, YouTube metadata as fallback), embeds square cover art
(Deezer, falling back to the YouTube thumbnail or existing cover, cropped square), verifies the result and files it as
`Album Artist/Album/01. Title.m4a` in the music folder.

Albums are matched on MusicBrainz as a whole (the release whose tracklist fits), each track
gets a single artist (others go into the title as "(ft. A, B)"), and every track of an album
shares one album artist: the most frequent primary artist.

The Library page re-tags album folders already in the music folder. Originals are hard-linked
into `.napster-backups/` inside the music folder first (no extra space; Navidrome ignores it via
`.ndignore`), so any re-tag can be undone byte-for-byte.

Everything configurable lives on the `/settings` page and is saved to `data/settings.json`.
Download history is kept in `data/jobs.json`, backups in `data/backups.json`,
YouTube cookies in `data/cookies.txt` (owner-only permissions; keep `data/` out of git).

## First-time setup

The shadcn-svelte components aren't committed yet:

```sh
bun install
bunx shadcn-svelte@latest init          # keep src/app.css, $lib aliases
bunx shadcn-svelte@latest add button input badge progress label select radio-group switch textarea checkbox sheet tabs collapsible
```

## Local dev (macOS)

```sh
brew install yt-dlp ffmpeg deno
bun run dev   # music folder defaults to ~/Downloads, data in ./data
```

## Server

```sh
cp .env.example .env   # set ORIGIN, MUSIC_DIR, PORT (and NAPSTER_IMAGE to pull a prebuilt image)
docker compose pull && docker compose up -d     # or: docker compose up -d --build
```

Then set the MusicBrainz contact and file owner in Settings.

## YouTube cookies

Settings can read cookies straight from a browser (like `yt-dlp --cookies-from-browser`) and
refresh them before every download. That only works where napster runs next to the browser
(your Mac in dev). For the server, run this on the Mac whenever downloads start failing:

```sh
scripts/sync-cookies.sh firefox https://napster.example.com   # or chrome, brave, safari, chrome:"Profile 1", …
```

Only youtube.com cookies are ever stored or sent.
