export type TrackStatus =
	| 'queued'
	| 'downloading'
	| 'waiting' // downloaded; waiting for the rest of the album before matching
	| 'tagging'
	| 'done'
	| 'skipped'
	| 'failed';

export type MetadataSource = 'musicbrainz' | 'youtube' | 'existing';
export type ArtSource = 'coverartarchive' | 'deezer' | 'youtube' | 'existing';

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
}

/** How one album's metadata was decided; shown so wrong matches are easy to spot. */
export interface AlbumMatch {
	album: string;
	albumArtist: string;
	year?: string;
	source: MetadataSource;
	releaseId?: string;
	matched: number;
	total: number;
	artSource?: ArtSource;
	note?: string;
}

export interface JobState {
	id: string;
	kind: 'track' | 'playlist' | 'retag';
	title: string;
	url?: string;
	folder?: string;
	createdAt: number;
	status: 'resolving' | 'running' | 'done' | 'failed';
	error?: string;
	warnings?: string[];
	tracks: TrackState[];
	albums: AlbumMatch[];
	backupId?: string;
	restored?: boolean;
}

export interface LibraryAlbum {
	path: string; // relative to the music folder
	artist: string; // parent folder name ('' for folders at the top level)
	album: string; // folder name
	tracks: number;
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
