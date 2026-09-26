import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Boot-time paths only; everything user-facing lives in settings.json. */
export const config = {
	dataDir: resolve(env.DATA_DIR || (dev ? 'data' : '/data')),
	workDir: resolve(env.WORK_DIR || join(tmpdir(), 'napster'))
};
