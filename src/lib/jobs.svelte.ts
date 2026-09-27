import { getContext, setContext } from 'svelte';
import type { JobState, ReviewSummary } from '$lib/types';

export interface LiveState {
	jobs: JobState[];
	reviews: ReviewSummary[];
	connected: boolean;
}

const KEY = Symbol('napster-live');

/** Opens the one SSE connection for the whole app. Call once, in the root layout. */
export function provideLive(): LiveState {
	const state = $state<LiveState>({ jobs: [], reviews: [], connected: false });
	$effect(() => {
		const source = new EventSource('/api/events');
		source.onopen = () => (state.connected = true);
		source.onerror = () => (state.connected = false); // EventSource reconnects on its own
		source.onmessage = (e) => {
			const data = JSON.parse(e.data) as { jobs: JobState[]; reviews: ReviewSummary[] };
			state.jobs = data.jobs;
			state.reviews = data.reviews;
		};
		return () => source.close();
	});
	setContext(KEY, state);
	return state;
}

/** Live jobs and reviews, shared from the layout. */
export function useLive(): LiveState {
	return getContext<LiveState>(KEY);
}
