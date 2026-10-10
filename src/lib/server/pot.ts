import { building } from '$app/environment';
import { env } from '$env/dynamic/private';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

/**
 * The PO token provider (bgutil) generates the "proof of origin" tokens YouTube asks for
 * before it hands over audio. It ships inside the napster image and runs as a child of the
 * app, so there is one container to look after. It listens on localhost only.
 *
 * POT_PROVIDER_HOME (set in the Dockerfile) is where it's installed; without it nothing is
 * started, which is the case in local development.
 */

const PORT = '4416';
/** Unprivileged: the provider runs YouTube's own JavaScript, so it gets no access to the library. */
const NOBODY = 65534;

let child: ChildProcess | undefined;
let stopping = false;
let restartDelay = 1000;

function log(line: string) {
	// It prints every token it makes; the container log doesn't need them.
	if (line.trim() && !/^(poToken|Generated IntegrityToken):/.test(line)) console.log(`[pot-provider] ${line}`);
}

function pipe(stream: NodeJS.ReadableStream | null) {
	if (!stream) return;
	let buffer = '';
	stream.setEncoding('utf8');
	stream.on('data', (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) log(line);
	});
	stream.on('end', () => log(buffer));
}

function launch(home: string) {
	const modules = join(home, 'node_modules');
	const startedAt = Date.now();
	const asRoot = process.getuid?.() === 0;
	child = spawn(
		'deno',
		[
			'run',
			'--allow-env',
			'--allow-net',
			`--allow-ffi=${modules}`,
			`--allow-read=${modules}`,
			join(home, 'src', 'main.ts'),
			'--port',
			PORT
		],
		{
			cwd: home,
			stdio: ['ignore', 'pipe', 'pipe'],
			...(asRoot ? { uid: NOBODY, gid: NOBODY } : {}),
			// Its own small environment: none of napster's settings are its business.
			env: {
				PATH: process.env.PATH,
				HOME: home,
				DENO_DIR: join(home, '.cache', 'deno'),
				DENO_NO_PROMPT: '1',
				DENO_NO_UPDATE_CHECK: '1',
				...Object.fromEntries(
					['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'TOKEN_TTL']
						.filter((k) => process.env[k])
						.map((k) => [k, process.env[k]])
				)
			}
		}
	);
	pipe(child.stdout);
	pipe(child.stderr);

	const again = (why: string) => {
		if (child === undefined) return; // 'error' and 'exit' can both fire
		child = undefined;
		if (stopping) return;
		// Ran fine for a while: start over quickly. Dying at once: back off, up to 30 s.
		restartDelay = Date.now() - startedAt > 60_000 ? 1000 : Math.min(restartDelay * 2, 30_000);
		console.error(`[pot-provider] ${why}; restarting in ${restartDelay / 1000} s`);
		setTimeout(() => !stopping && launch(home), restartDelay).unref();
	};
	child.on('error', (err) => again(`could not start (${err.message})`));
	child.on('exit', (code, signal) => again(`stopped (${signal ?? `exit code ${code}`})`));
}

function stop() {
	stopping = true;
	child?.kill('SIGTERM');
}

// Vite re-runs this module on edits in dev; one provider per process is enough.
const once = globalThis as { __napsterPot?: boolean };

/** Starts the bundled provider and keeps it running. Called once when the server starts. */
export function startPotProvider() {
	const home = env.POT_PROVIDER_HOME;
	if (building || !home || once.__napsterPot) return;
	once.__napsterPot = true;
	launch(home);
	process.on('sveltekit:shutdown', stop);
	process.on('exit', stop);
}
