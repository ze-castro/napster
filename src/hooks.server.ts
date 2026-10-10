import type { ServerInit } from '@sveltejs/kit';
import { startPotProvider } from '$lib/server/pot';

export const init: ServerInit = () => {
	startPotProvider();
};
