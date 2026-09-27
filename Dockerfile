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
# Bump YTDLP_REFRESH (or rebuild without cache) to pick up a new yt-dlp release.
ARG YTDLP_REFRESH=0
RUN python3 -m venv /opt/yt-dlp \
	&& /opt/yt-dlp/bin/pip install --no-cache-dir -U "yt-dlp[default]" \
	&& ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

WORKDIR /app
# adapter-node bundles devDependencies, so no node_modules at runtime.
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./

ENV NODE_ENV=production \
	PORT=3000 \
	DATA_DIR=/data \
	WORK_DIR=/tmp/napster \
	XDG_CACHE_HOME=/tmp/cache
# Cover uploads in the tag editor; adapter-node's default request limit is 512 KB.
ENV BODY_SIZE_LIMIT=20M
EXPOSE 3000
CMD ["bun", "build/index.js"]
