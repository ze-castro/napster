import type { AlbumTagsInput, TrackTagsInput } from '$lib/types';
import { withFeatured } from './artists';

export interface Tags {
	title?: string;
	artist?: string;
	albumArtist?: string;
	album?: string;
	trackNumber?: number;
	trackCount?: number;
	discNumber?: number;
	discCount?: number;
	year?: string;
	genre?: string;
	compilation?: boolean;
}

/** Fields the verifier requires; genre and totals are nice-to-have. */
export const REQUIRED_TAGS = ['title', 'artist', 'albumArtist', 'album', 'trackNumber', 'year'] as const;


/** Form/Deezer fields → the tags written to the file. The title gets "(ft. …)" appended. */
export function toTags(album: AlbumTagsInput, t: TrackTagsInput): Tags {
	const disc = t.discNumber ?? (album.discCount && album.discCount > 1 ? 1 : undefined);
	return {
		title: withFeatured(t.title, t.featured),
		artist: t.artist,
		albumArtist: album.albumArtist,
		album: album.album,
		trackNumber: t.trackNumber,
		// Never write "4/1": a total below the track number means the count is wrong.
		trackCount: (() => {
			const total = album.tracksPerDisc?.[disc ?? 1];
			return total && (!t.trackNumber || total >= t.trackNumber) ? total : undefined;
		})(),
		discNumber: disc,
		discCount: album.discCount && album.discCount > 1 ? album.discCount : undefined,
		year: album.year,
		genre: album.genre
	};
}
