#!/usr/bin/env bash
# Reads your signed-in YouTube session from a browser on this Mac and sends it to napster.
# Only youtube.com cookies leave this machine.
#
#   scripts/sync-cookies.sh <browser[:profile]> <napster-url>
#   scripts/sync-cookies.sh firefox https://napster.example.com
#
# Browsers: firefox, chrome, brave, edge, chromium, opera, vivaldi, safari
set -euo pipefail

BROWSER="${1:-firefox}"
NAPSTER_URL="${2:-${NAPSTER_URL:-}}"
if [ -z "$NAPSTER_URL" ]; then
	echo "Usage: $0 <browser[:profile]> <napster-url>   (or set NAPSTER_URL)" >&2
	exit 1
fi

tmp="$(mktemp -d)"
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT

echo "Reading cookies from $BROWSER…"
# yt-dlp saves the cookie jar even if the page itself errors, so the exit code is ignored.
yt-dlp --cookies-from-browser "$BROWSER" --cookies "$tmp/all.txt" \
	--flat-playlist --skip-download --quiet --no-warnings "https://www.youtube.com" || true

if [ ! -s "$tmp/all.txt" ]; then
	echo "Could not read cookies from $BROWSER. Check the browser name and that you're signed in to YouTube." >&2
	exit 1
fi

{
	echo "# Netscape HTTP Cookie File"
	grep -E $'^(#HttpOnly_)?([^\t]*\\.)?youtube\\.com\t' "$tmp/all.txt" || true
} > "$tmp/youtube.txt"

echo "Sending YouTube cookies to $NAPSTER_URL…"
curl -sS --fail-with-body -X PUT \
	-H 'Content-Type: application/octet-stream' \
	--data-binary @"$tmp/youtube.txt" \
	"$NAPSTER_URL/api/cookies"
echo
echo "Done."
