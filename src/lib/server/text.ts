/** Lowercase, strip accents, drop "(Remastered)", "[Official Video]", "feat." etc. for fuzzy comparison. */
export function normalize(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/\s*[([].*?[)\]]\s*/g, ' ')
		.replace(/\s+-\s+.*remaster.*$/, '')
		.replace(/\b(feat|ft)\.?\s.*$/, '')
		.replace(/&/g, 'and')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

export function sameish(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	const na = normalize(a);
	const nb = normalize(b);
	return na.length > 0 && (na === nb || na.includes(nb) || nb.includes(na));
}

/**
 * Makes a string safe as a single path segment. Metadata comes from third parties,
 * so this is also the path-traversal guard ("../", "/", leading dots).
 */
export function safeSegment(s: string | undefined, fallback: string): string {
	const cleaned = (s ?? '')
		.normalize('NFC')
		.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_')
		.replace(/^[.\s]+/, '')
		.replace(/[.\s]+$/, '')
		.slice(0, 150)
		.trim();
	return cleaned || fallback;
}

/** Escapes Lucene special characters for MusicBrainz search queries. */
export function lucene(s: string): string {
	return s.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
}
