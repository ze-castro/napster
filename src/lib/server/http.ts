export const DEFAULT_UA = 'napster/1.0';

export async function getJson<T>(url: string, userAgent = DEFAULT_UA, timeoutMs = 15000): Promise<T | undefined> {
	const res = await fetch(url, {
		headers: { 'User-Agent': userAgent, Accept: 'application/json' },
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (res.status === 404) return undefined;
	if (!res.ok) throw new Error(`${new URL(url).hostname} responded ${res.status}`);
	return (await res.json()) as T;
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** Downloads an image; undefined for errors, non-images or anything over 15 MB. Follows redirects. */
export async function getImage(url: string, timeoutMs = 20000): Promise<Buffer | undefined> {
	const res = await fetch(url, {
		headers: { 'User-Agent': DEFAULT_UA },
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!res.ok) return undefined;
	if (!res.headers.get('content-type')?.startsWith('image/')) return undefined;
	if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return undefined;
	const buf = Buffer.from(await res.arrayBuffer());
	return buf.length <= MAX_IMAGE_BYTES ? buf : undefined;
}
