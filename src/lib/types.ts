export type TrackStatus =
	| 'queued'
	| 'downloading'
	| 'waiting' // downloaded; waiting for the rest of the album before matching
	| 'tagging'
	| 'needs-input' // no confident Deezer match; waiting in a review
	| 'done'
	| 'skipped'
	| 'failed';

export type MetadataSource = 'deezer' | 'manual';
export type ArtSource = 'deezer' | 'youtube' | 'existing' | 'upload' | 'url';

export interface TrackState {
	key: string; // videoId for downloads, library-relative path for re-tags
	title: string;
	status: TrackStatus;
	progress: number; // 0–100, download only
	path?: string; // relative to the music folder
	warnings: string[];
	error?: string;
	/** Re-tag only: human-readable "field: old → new" lines. */
	changes?: string[];
	/** Set while the track waits in a review. */
	reviewId?: string;
}

/** How one album's tags were decided; shown so wrong matches are easy to spot. */
export interface AlbumMatch {
	album: string;
	albumArtist: string;
	year?: string;
	source: MetadataSource;
	deezerAlbumId?: number;
	matched: number;
	total: number;
	artSource?: ArtSource;
	note?: string;
}

export interface JobState {
	id: string;
	kind: 'track' | 'playlist' | 'retag' | 'edit';
	title: string;
	url?: string;
	folder?: string;
	createdAt: number;
	status: 'resolving' | 'running' | 'needs-input' | 'done' | 'failed';
	error?: string;
	warnings?: string[];
	tracks: TrackState[];
	albums: AlbumMatch[];
	/** One per re-tagged album (a playlist folder can make several). */
	backupIds: string[];
	restored?: boolean;
}

export interface LibraryAlbum {
	path: string; // relative to the music folder
	artist: string; // parent folder name ('' for folders at the top level)
	album: string; // folder name
	tracks: number;
	/** File names without extension, e.g. "01. Song (ft. X)", so search can find songs. */
	songs: string[];
	/** Changes when the folder's first song changes; used to refresh cached covers. */
	version: number;
}

export interface LibraryTrack {
	file: string; // file name within the folder
	title?: string;
	artist?: string;
	albumArtist?: string;
	album?: string;
	track?: string;
	year?: string;
	durationSec?: number;
}

export interface BackupSummary {
	id: string;
	createdAt: number;
	label: string;
	files: number;
}

// ---------------------------------------------------------------- tag editing

/** One song's editable tags. `title` excludes "(ft. …)"; featured artists are listed separately. */
export interface TrackTagsInput {
	key: string;
	title: string;
	artist: string;
	featured: string[];
	trackNumber?: number;
	discNumber?: number;
}

export interface AlbumTagsInput {
	album: string;
	albumArtist: string;
	year?: string;
	genre?: string;
	/** From Deezer; not editable, used for "3/12" track totals. */
	tracksPerDisc?: Record<number, number>;
	discCount?: number;
}

/** A Deezer album's tags mapped onto the songs being tagged. */
export interface Proposal {
	deezerAlbumId: number;
	deezerUrl: string;
	coverUrl?: string;
	album: AlbumTagsInput;
	tracks: TrackTagsInput[];
	/** How many of our songs found their song on this album. */
	matched: number;
	total: number;
}

export interface DeezerAlbumResult {
	id: number;
	title: string;
	artist: string;
	cover?: string; // small, for lists
	tracks: number;
	type: string; // album | single | ep | compile
}

export interface DeezerTrackResult {
	id: number;
	title: string;
	artist: string;
	album: string;
	albumId: number;
	cover?: string;
	durationSec: number;
}

export type ReviewReason = 'not-found' | 'close-match' | 'edit';

export interface ReviewSummary {
	id: string;
	jobId: string;
	kind: 'download' | 'retag' | 'edit';
	title: string;
	reason: ReviewReason;
	note?: string;
	songs: number;
	createdAt: number;
}

export interface ReviewTrack extends TrackTagsInput {
	file: string; // display name
	durationSec?: number;
}

export interface ReviewDetail extends ReviewSummary {
	current: AlbumTagsInput & { tracks: ReviewTrack[] };
	candidate?: Proposal;
	/** A cover we already have: the YouTube thumbnail or the file's embedded cover. */
	currentCover?: 'youtube' | 'existing';
	/** Suggested Deezer search. */
	query: string;
	/** Songs whose file was moved or deleted after the review was created. */
	missing?: string[];
}

export type CoverChoice =
	| { type: 'deezer'; url: string }
	| { type: 'url'; url: string }
	| { type: 'current' }
	| { type: 'upload' };

export interface ResolveInput {
	album: AlbumTagsInput;
	tracks: TrackTagsInput[];
	cover: CoverChoice;
	deezerAlbumId?: number;
}
