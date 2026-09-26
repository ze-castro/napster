import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import type { SystemUser } from '$lib/settings';

// In Docker, the host's files are mounted under /host so we list the server's users, not the container's.
const PASSWD = ['/host/etc/passwd', '/etc/passwd'];
const GROUP = ['/host/etc/group', '/etc/group'];

async function readFirst(paths: string[]): Promise<string> {
	for (const p of paths) {
		try {
			return await readFile(p, 'utf8');
		} catch {
			// try next
		}
	}
	return '';
}

/** root plus regular login users (uid 1000–65533). */
export async function listUsers(): Promise<SystemUser[]> {
	const groups = new Map<number, string>();
	for (const line of (await readFirst(GROUP)).split('\n')) {
		const [name, , gid] = line.split(':');
		if (name && gid) groups.set(Number(gid), name);
	}

	const users = new Map<number, SystemUser>();
	for (const line of (await readFirst(PASSWD)).split('\n')) {
		const [name, , uidStr, gidStr] = line.split(':');
		const uid = Number(uidStr);
		const gid = Number(gidStr);
		if (!name || !Number.isInteger(uid) || !Number.isInteger(gid)) continue;
		if (uid !== 0 && (uid < 1000 || uid >= 65534)) continue;
		users.set(uid, { name, uid, gid, group: groups.get(gid) ?? String(gid) });
	}

	// macOS keeps real users out of /etc/passwd; make sure the dev user is listed.
	const me = userInfo();
	if (!users.has(me.uid)) {
		users.set(me.uid, { name: me.username, uid: me.uid, gid: me.gid, group: groups.get(me.gid) ?? String(me.gid) });
	}
	return [...users.values()].sort((a, b) => a.uid - b.uid);
}
