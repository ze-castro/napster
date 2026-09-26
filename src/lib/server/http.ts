export const DEFAULT_UA = 'napster/0.2';

export async function getJson<T>(url: string, userAgent = DEFAULT_UA, timeoutMs = 15000): Promise<T | undefined> {
	const res = await fetch(url, {
		headers: { 'User-Agent': userAgent, Accept: 'application/json' },
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (res.status === 404) return undefined;
	if (!res.ok) throw new Error(`${new URL(url).hostname} responded ${res.status}`);
	return (await res.json()) as T;
}

/** Downloads a binary; returns undefined for 404 or non-image responses. Follows redirects (CAA uses them). */
export async function getImage(url: string, timeoutMs = 20000): Promise<Buffer | undefined> {
	const res = await fetch(url, {
		headers: { 'User-Agent': DEFAULT_UA },
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!res.ok) return undefined;
	if (!res.headers.get('content-type')?.startsWith('image/')) return undefined;
	return Buffer.from(await res.arrayBuffer());
}
