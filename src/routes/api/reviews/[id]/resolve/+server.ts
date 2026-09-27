import { error } from '@sveltejs/kit';
import { resolveReview } from '$lib/server/jobs';
import { getReview } from '$lib/server/reviews';
import type { AlbumTagsInput, CoverChoice, ResolveInput, TrackTagsInput } from '$lib/types';
import type { RequestHandler } from './$types';

const MAX_UPLOAD = 15 * 1024 * 1024;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v: unknown, min: number, max: number) =>
	typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
const httpUrl = (v: unknown) => {
	const s = text(v, 2000);
	return /^https?:\/\/\S+$/i.test(s) ? s : undefined;
};

/** Validates the form payload; everything ends up in ffmpeg arguments and file names. */
function parse(raw: unknown, keys: Set<string>): ResolveInput {
	const body = (raw ?? {}) as Record<string, unknown>;
	const a = (body.album ?? {}) as Record<string, unknown>;

	const tracksPerDisc: Record<number, number> = {};
	if (a.tracksPerDisc && typeof a.tracksPerDisc === 'object') {
		for (const [disc, count] of Object.entries(a.tracksPerDisc)) {
			const d = int(Number(disc), 1, 99);
			const c = int(count, 1, 999);
			if (d && c) tracksPerDisc[d] = c;
		}
	}
	const album: AlbumTagsInput = {
		album: text(a.album, 200),
		albumArtist: text(a.albumArtist, 200),
		year: /^\d{4}$/.test(text(a.year, 4)) ? text(a.year, 4) : undefined,
		genre: text(a.genre, 100) || undefined,
		tracksPerDisc: Object.keys(tracksPerDisc).length ? tracksPerDisc : undefined,
		discCount: int(a.discCount, 1, 99)
	};
	if (!album.album) error(400, 'Album is required.');
	if (!album.albumArtist) error(400, 'Album artist is required.');

	if (!Array.isArray(body.tracks)) error(400, 'Songs are missing.');
	const tracks: TrackTagsInput[] = body.tracks.map((raw) => {
		const t = (raw ?? {}) as Record<string, unknown>;
		const key = typeof t.key === 'string' ? t.key : '';
		if (!keys.has(key)) error(400, 'Unknown song in the form.');
		const track: TrackTagsInput = {
			key,
			title: text(t.title, 300),
			artist: text(t.artist, 200),
			featured: Array.isArray(t.featured) ? t.featured.map((f) => text(f, 200)).filter(Boolean).slice(0, 20) : [],
			trackNumber: int(t.trackNumber, 1, 999),
			discNumber: int(t.discNumber, 1, 99)
		};
		if (!track.title || !track.artist) error(400, 'Every song needs a title and an artist.');
		return track;
	});
	if (tracks.length !== keys.size) error(400, 'Every song needs its tags.');

	const c = (body.cover ?? {}) as Record<string, unknown>;
	let cover: CoverChoice;
	if (c.type === 'deezer' || c.type === 'url') {
		const url = httpUrl(c.url);
		if (!url) error(400, 'The cover URL must start with http:// or https://.');
		cover = { type: c.type, url };
	} else if (c.type === 'upload' || c.type === 'current') cover = { type: c.type };
	else error(400, 'Pick a cover.');

	const deezerAlbumId = int(body.deezerAlbumId, 1, Number.MAX_SAFE_INTEGER);
	return { album, tracks, cover, deezerAlbumId };
}

/** multipart/form-data: "data" = ResolveInput JSON, optional "cover" = image file. */
export const POST: RequestHandler = async ({ params, request }) => {
	const review = await getReview(params.id);
	if (!review) error(404, 'This review no longer exists.');

	const form = await request.formData();
	let raw: unknown;
	try {
		raw = JSON.parse(String(form.get('data') ?? ''));
	} catch {
		error(400, 'Malformed form data.');
	}
	const input = parse(raw, new Set(review.files.map((f) => f.key)));

	let upload: Buffer | undefined;
	const file = form.get('cover');
	if (input.cover.type === 'upload') {
		if (!(file instanceof File) || !file.size) error(400, 'Choose an image to upload.');
		if (file.size > MAX_UPLOAD) error(400, 'That image is over 15 MB.');
		upload = Buffer.from(await file.arrayBuffer());
	}

	try {
		await resolveReview(params.id, input, upload);
	} catch (err) {
		error(400, (err as Error).message);
	}
	return new Response(null, { status: 204 });
};
