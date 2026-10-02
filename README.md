<p align="center">
  <img src="static/icon-180.png" width="112" height="112" alt="napster logo">
</p>

<h1 align="center">napster</h1>

A self-hosted web app that turns YouTube Music links into a tidy, fully tagged music library.

- **Downloads:** paste a song, album or playlist link and get `.m4a` files with correct tags and square cover art, filed as `Album Artist/Album/01. Title.m4a`.
- **Library:** browse the music folder, re-tag albums already on disk in bulk, and undo any re-tag byte-for-byte.

<p align="center">
  <img src="docs/screenshot.png" alt="napster downloading an album" width="820">
</p>

## Features

- **Best audio.** yt-dlp takes YouTube's AAC stream as-is when it's offered, otherwise converts the Opus stream to AAC at 192 kbps. Low-bitrate (48 kbps) streams are retried and flagged.
- **Deezer metadata.** Tags and covers come from [Deezer](https://www.deezer.com). Albums are matched as a whole, by comparing tracklists, so songs never drift onto compilations or deluxe editions. Single songs are matched by title, artist and length, with "(Official Video)", "(Lyrics)" and similar removed first.
- **You decide when it's unsure.** Anything without a confident match waits under **Needs input**: compare your tags with Deezer's closest result, search Deezer yourself, or type the tags and pick a cover by hand. Downloads wait safely on disk until you save or discard them.
- **Edit tags any time.** Open any library folder in the same editor, with a backup and Undo.
- **Clean artist tags.** One artist per track; everyone else goes into the title as `(ft. A, B)`. Every song on an album shares one album artist (the most frequent one), so albums show up as one album in Navidrome, Jellyfin and Plex.
- **Square covers.** Covers come from Deezer, at 1000 or 500 px, and fall back to the YouTube thumbnail or the existing cover, cropped square.
- **Every file is verified.** It's read back after writing to check its tags and cover.
- **Safe re-tagging.** Originals are hard-linked into a hidden backup folder first (no extra disk space), so any re-tag can be undone.
- **YouTube cookies.** Upload a `cookies.txt` in Settings, or read them straight from a browser when running locally. A helper script exports just the youtube.com cookies from your computer's browser. Only youtube.com cookies are kept.
- **Easy to run.** No database: settings and history are small JSON files. Everything is configured in the app's Settings page.

## Stack

SvelteKit (Svelte 5) · TypeScript · Tailwind CSS v4 · shadcn-svelte · Bun · yt-dlp · ffmpeg · Docker Compose

## Run locally (macOS)

```sh
brew install oven-sh/bun/bun yt-dlp ffmpeg deno
bun install
bun run dev
```

The shadcn-svelte components are committed in `src/lib/components/ui/`. If that folder is missing (for example, in a copy made without it), add them first:

```sh
bunx shadcn-svelte@latest init   # accept the defaults: src/app.css and the $lib aliases
bunx shadcn-svelte@latest add button input badge progress label select radio-group switch textarea checkbox sheet tabs collapsible dialog
```

Open http://localhost:5173 and go to **Settings**:

1. Set the **Music folder** (a full path; in dev it defaults to `~/Downloads`).
2. Under **YouTube cookies**, pick your browser, turn on **Refresh before every download**, and click **Import now and save**.

On macOS, Chrome-based browsers ask for Keychain access on import, and Safari needs Full Disk Access for your terminal.

## Host it (Docker)

The image is built by GitHub Actions and pushed to `ghcr.io/<owner>/<repo>:latest` on every push to `main`. It's `linux/amd64` only. On ARM servers, build it locally with `docker compose up -d --build`.

**1. Configure it.** On the server, next to `compose.yaml`:

```sh
cp .env.example .env
```

```sh
ORIGIN=https://napster.example.com   # the exact URL you open it at
MUSIC_DIR=/path/to/music             # must exist and be writable
PORT=3000
NAPSTER_IMAGE=ghcr.io/<owner>/napster:latest   # omit to build locally
```

**2. Start it:**

```sh
docker compose pull && docker compose up -d     # or: docker compose up -d --build
docker compose logs -f
```

**3. Finish setup** in **Settings**: keep the music folder as `/music` and pick the **file owner** (the user that owns your music).

**4. Add cookies.** There's no browser on the server, so export cookies on your computer and upload the file in **Settings → YouTube cookies**.

YouTube rotates the cookies of any session that's open in a browser, which makes an exported copy stop working soon after ("The provided YouTube account cookies are no longer valid" in the logs). Export a session that the browser then forgets _without signing out_. The steps below are for Safari on macOS. Use a throwaway Google account, because the steps sign you out of Google in Safari, and yt-dlp use can get an account restricted.

1. In Safari → Settings → Privacy → **Manage Website Data…**, remove `youtube` and `google`.
2. Sign in with the throwaway account at `music.youtube.com`.
3. In the same tab, go to `https://www.youtube.com/robots.txt` and close any other YouTube or Google tabs.
4. Quit Safari (⌘Q) so the cookies are written to disk.
5. Export them. Your terminal needs Full Disk Access to read Safari's cookies.

   ```sh
   scripts/sync-cookies.sh safari   # writes ~/Downloads/youtube-cookies.txt
   ```

6. Upload the file in **Settings → YouTube cookies**, then delete it: it's a live login.

   ```sh
   rm ~/Downloads/youtube-cookies.txt
   ```

7. Reopen Safari, close the robots.txt tab, and remove `youtube` and `google` website data again. **Don't sign out:** that ends the session on YouTube's side too.

Never open that session in a browser again. Repeat these steps only if the logs show the cookies are invalid again.

In Chrome or Firefox, a private window does the same job: sign in, go to `robots.txt`, export with the "Get cookies.txt LOCALLY" extension, and close the window. `sync-cookies.sh` can't read private-window cookies.

> [!IMPORTANT]
> napster has no login. Keep it on your local network, or put an authentication layer in front of it (for example Cloudflare Access) before exposing it to the internet.

### Updating

```sh
docker compose pull && docker compose up -d
```

YouTube regularly breaks old yt-dlp versions. To get the latest one into the image, bump `ARG YTDLP_REFRESH` in the `Dockerfile` and push. For a quick fix until the container is next recreated:

```sh
docker compose exec napster /opt/yt-dlp/bin/pip install -U "yt-dlp[default]"
```

## Where things live

| What                                                               | Where                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Settings, history, reviews, backup list, cookies, cover thumbnails | `data/`                                                                   |
| Downloads waiting under **Needs input**                            | `data/pending/`                                                           |
| Downloaded and re-tagged music                                     | the music folder                                                          |
| Backups of re-tagged originals                                     | `<music folder>/.napster-backups/` (skipped by Navidrome via `.ndignore`) |

## Development

```sh
bunx shadcn-svelte@latest add <component>   # UI components live in src/lib/components/ui
bun run check                                # svelte-check + TypeScript
bun run build
```

CI (`.github/workflows/ci.yml`) runs the checks and builds the Docker image on every push and pull request.