// Artist credit rules: the artist tag holds exactly one artist; everyone else goes into
// the title as "(ft. A, B)". Featured wording already in titles is removed and rebuilt.

// One level of nesting allowed inside, e.g. "(feat. X (of Band))".
const FEAT_PAREN = /\s*\(\s*(?:feat\.?|ft\.?|featuring|with)\s+((?:[^()]|\([^()]*\))+)\)/gi;
const FEAT_SQUARE = /\s*\[\s*(?:feat\.?|ft\.?|featuring|with)\s+((?:[^[\]]|\[[^[\]]*\])+)\]/gi;
const FEAT_TRAILING = /\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$/i;

const key = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Splits a list of names. "&" is only split in title fragments, never in credits (e.g. "Simon & Garfunkel"). */
function splitNames(s: string, splitAmpersand: boolean): string[] {
	const re = splitAmpersand ? /\s*,\s*|\s*;\s*|\s+&\s+/ : /\s*,\s*|\s*;\s*/;
	return s.split(re).map((n) => n.trim()).filter(Boolean);
}

export function stripFeat(title: string): { base: string; names: string[] } {
	const names: string[] = [];
	const collect = (_: string, n: string) => {
		names.push(...splitNames(n, true));
		return '';
	};
	let base = title.replace(FEAT_PAREN, collect).replace(FEAT_SQUARE, collect);
	const m = FEAT_TRAILING.exec(base);
	if (m) {
		names.push(...splitNames(m[1], true));
		base = base.slice(0, m.index);
	}
	return { base: balanceBrackets(base).replace(/\s{2,}/g, ' ').trim(), names };
}

/** Parses a free-text artist field ("A, B", "A feat. B", "A; B") into names, primary first. */
export function parseArtistField(s: string | undefined): string[] {
	if (!s) return [];
	const { base, names } = stripFeat(s);
	return dedupe([...splitNames(base, false), ...names]);
}

function dedupe(names: string[]): string[] {
	const seen = new Set<string>();
	return names.filter((n) => {
		const k = key(n);
		if (!k || seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

/**
 * credits: ordered artist names (primary first). Title "feat." text is only used for
 * names when the credits list nobody but the primary artist.
 */
/**
 * Splits credits into one main artist, the featured artists and the bare title.
 * Title "feat." text only adds names when the credits list nobody but the main artist.
 */
export function creditParts(credits: string[], title: string): { artist?: string; featured: string[]; title: string } {
	const { base, names } = stripFeat(title);
	const all = dedupe(credits.length > 1 ? credits : [...credits, ...names]);
	const [artist, ...featured] = all;
	return { artist, featured, title: base };
}

/** Joins a bare title and featured artists: "Song (ft. A, B)". */
export function withFeatured(title: string, featured: string[]): string {
	const base = stripFeat(title).base || title.trim();
	const names = dedupe(featured.map((f) => f.trim()));
	return names.length ? `${base} (ft. ${names.join(', ')})` : base;
}

/** credits: ordered artist names (primary first). Returns the single artist and the "(ft. …)" title. */
export function creditTrack(credits: string[], title: string): { artist?: string; title: string } {
	const parts = creditParts(credits, title);
	return { artist: parts.artist, title: withFeatured(parts.title, parts.featured) };
}

/** Most frequent name; ties go to whichever appears first in the list. */
export function majority(names: (string | undefined)[]): string | undefined {
	const counts = new Map<string, { name: string; count: number; first: number }>();
	names.forEach((name, i) => {
		if (!name) return;
		const k = key(name);
		const entry = counts.get(k);
		if (entry) entry.count++;
		else counts.set(k, { name, count: 1, first: i });
	});
	let best: { name: string; count: number; first: number } | undefined;
	for (const e of counts.values()) {
		if (!best || e.count > best.count || (e.count === best.count && e.first < best.first)) best = e;
	}
	return best?.name;
}

export const artistKey = key;

// Words that mark a bracket or suffix as video decoration rather than part of the song title.
const NOISE_WORDS = /\b(official|lyrics?|video|audio|visuali[sz]er|m\/?v|hd|hq|4k|8d|color coded|letra|paroles)\b/i;

/**
 * Removes video decoration: "(Lyrics)", "[Official Music Video]", "(Visualizer)",
 * "| Official Audio", a trailing "Lyric Video"… Keeps "(Remix)", "(Live)", "(feat. X)".
 */
export function stripVideoNoise(title: string): { text: string; noisy: boolean } {
	let noisy = false;
	// Innermost groups first, repeated, so "(ft. X (Official Video))" loses only the inner group.
	const innermost = /\s*[([{【]([^()[\]{}【】]*)[)\]}】]/g;
	let text = title;
	for (let prev = ''; prev !== text; ) {
		prev = text;
		text = text.replace(innermost, (m, inner: string) => {
			if (!NOISE_WORDS.test(inner)) return m;
			noisy = true;
			return '';
		});
	}
	text = text.replace(/\s+(?:\||\/\/)\s+.*$/, (m) => {
		if (!NOISE_WORDS.test(m)) return m;
		noisy = true;
		return '';
	});
	text = text.replace(/\s+(?:official\s+(?:music\s+)?video|official\s+audio|lyric\s+video|lyrics)\s*$/i, () => {
		noisy = true;
		return '';
	});
	return { text: balanceBrackets(text).replace(/\s{2,}/g, ' ').trim(), noisy };
}

const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{', '】': '【' };

/** Drops brackets left without a partner, so a malformed title never ends in a stray ")". */
export function balanceBrackets(text: string): string {
	const chars = [...text];
	const open: number[] = [];
	const drop = new Set<number>();
	chars.forEach((c, i) => {
		if ('([{【'.includes(c)) open.push(i);
		else if (c in PAIRS) {
			if (open.length && chars[open[open.length - 1]] === PAIRS[c]) open.pop();
			else drop.add(i);
		}
	});
	for (const i of open) drop.add(i);
	return chars.filter((_, i) => !drop.has(i)).join('');
}
