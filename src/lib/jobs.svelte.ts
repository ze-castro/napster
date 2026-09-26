import type { JobState } from '$lib/types';

/** Live job list over SSE. Call during component init. */
export function jobStream() {
	const state = $state({ jobs: [] as JobState[], connected: false });
	$effect(() => {
		const source = new EventSource('/api/events');
		source.onopen = () => (state.connected = true);
		source.onerror = () => (state.connected = false); // EventSource reconnects on its own
		source.onmessage = (e) => (state.jobs = JSON.parse(e.data) as JobState[]);
		return () => source.close();
	});
	return state;
}
