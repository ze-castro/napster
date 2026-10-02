#!/usr/bin/env bash
# Reads your signed-in YouTube session from a browser on this Mac and writes only the
# youtube.com cookies to a file, ready to upload in napster's Settings.
#
#   scripts/sync-cookies.sh <browser[:profile]> [output-file]
#   scripts/sync-cookies.sh safari ~/Downloads/youtube-cookies.txt
#
# Browsers: firefox, chrome, brave, edge, chromium, opera, vivaldi, safari
set -euo pipefail

BROWSER="${1:-firefox}"
OUT="${2:-$HOME/Downloads/youtube-cookies.txt}"

tmp="$(mktemp -d)"
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT

echo "Reading cookies from ${BROWSER}…"
# yt-dlp saves the cookie jar even if the page itself errors, so the exit code is ignored.
yt-dlp --cookies-from-browser "$BROWSER" --cookies "$tmp/all.txt" \
	--flat-playlist --skip-download --quiet --no-warnings "https://www.youtube.com" || true

if [ ! -s "$tmp/all.txt" ]; then
	echo "Could not read cookies from ${BROWSER}. Check the browser name and that you're signed in to YouTube." >&2
	exit 1
fi

{
	echo "# Netscape HTTP Cookie File"
	grep -E $'^(#HttpOnly_)?([^\t]*\\.)?youtube\\.com\t' "$tmp/all.txt" || true
} > "$tmp/youtube.txt"

count="$(grep -cE $'\t' "$tmp/youtube.txt" || true)"
if [ "$count" -eq 0 ]; then
	echo "No youtube.com cookies found in ${BROWSER}. Sign in to YouTube there first." >&2
	exit 1
fi

# The file grants access to the Google account: owner-only, written atomically.
(umask 077 && cp "$tmp/youtube.txt" "$OUT.tmp")
mv "$OUT.tmp" "$OUT"

echo "Wrote ${count} youtube.com cookies to ${OUT}"
echo "Upload it in napster → Settings, then delete it: rm '${OUT}'"