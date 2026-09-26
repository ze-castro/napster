import { spawn } from 'node:child_process';

export interface RunResult {
	stdout: string;
	stderr: string;
}

/** Runs a binary with an argument array (no shell, so no injection via args). */
export function run(
	cmd: string,
	args: string[],
	onLine?: (line: string) => void,
	timeoutMs?: number
): Promise<RunResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let timedOut = false;
		const timer = timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill('SIGKILL');
				}, timeoutMs)
			: undefined;
		let stdout = '';
		let stderr = '';
		let buffer = '';

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');

		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
			if (!onLine) return;
			buffer += chunk;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) onLine(line);
		});
		child.stderr.on('data', (chunk: string) => {
			// Keep only the tail; yt-dlp can be chatty.
			stderr = (stderr + chunk).slice(-8000);
		});

		child.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (timedOut) reject(new Error(`${cmd} took longer than ${Math.round(timeoutMs! / 1000)} s and was stopped.`));
			else if (code === 0) resolvePromise({ stdout, stderr });
			else {
				const last = stderr.trim().split('\n').slice(-3).join('\n');
				reject(new Error(`${cmd} exited with ${code}: ${last}`));
			}
		});
	});
}
