import { ready, snapshot, subscribe } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

/** Server-sent events: pushes all jobs and open reviews on every change (both are small). */
export const GET: RequestHandler = async ({ request }) => {
	await ready;
	const encoder = new TextEncoder();
	let cleanup = () => {};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (chunk: string) => {
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					cleanup();
				}
			};
			const push = () => send(`data: ${JSON.stringify(snapshot())}\n\n`);

			push();
			const unsubscribe = subscribe(push);
			// Comment lines keep idle proxies from closing the connection.
			const heartbeat = setInterval(() => send(': ping\n\n'), 25000);

			cleanup = () => {
				unsubscribe();
				clearInterval(heartbeat);
			};
			request.signal.addEventListener('abort', cleanup);
		},
		cancel() {
			cleanup();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive'
		}
	});
};
