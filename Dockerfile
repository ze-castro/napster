# The PO token provider (bgutil): the server half is copied from its image below, and its
# yt-dlp plugin is installed with pip. Both must be the same version.
ARG POT_PROVIDER_VERSION=2.0.2

FROM brainicism/bgutil-ytdlp-pot-provider:${POT_PROVIDER_VERSION}-deno AS pot-provider

FROM oven/bun:1-debian AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-debian
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# yt-dlp[default] pulls in yt-dlp-ejs, which YouTube now needs; Deno is its default JS runtime.
# bgutil-ytdlp-pot-provider is the yt-dlp plugin that asks the provider below for PO tokens.
# Bump YTDLP_REFRESH (or rebuild without cache) to pick up a new yt-dlp release.
ARG YTDLP_REFRESH=0
ARG POT_PROVIDER_VERSION
RUN python3 -m venv /opt/yt-dlp \
	&& /opt/yt-dlp/bin/pip install --no-cache-dir -U "yt-dlp[default]" "bgutil-ytdlp-pot-provider==${POT_PROVIDER_VERSION}" \
	&& ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

# The provider itself. napster starts it as an unprivileged child process (src/lib/server/pot.ts),
# listening on localhost only, so the app stays a single container.
COPY --from=pot-provider --chown=65534:65534 /app /opt/pot-provider

WORKDIR /app
# adapter-node bundles devDependencies, so no node_modules at runtime.
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./

ENV NODE_ENV=production \
	PORT=3000 \
	DATA_DIR=/data \
	WORK_DIR=/tmp/napster \
	XDG_CACHE_HOME=/tmp/cache \
	POT_PROVIDER_HOME=/opt/pot-provider \
	POT_PROVIDER_URL=http://127.0.0.1:4416
# Cover uploads in the tag editor; adapter-node's default request limit is 512 KB.
ENV BODY_SIZE_LIMIT=20M
EXPOSE 3000
CMD ["bun", "build/index.js"]
