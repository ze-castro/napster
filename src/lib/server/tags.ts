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
