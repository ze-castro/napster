import { fail } from '@sveltejs/kit';
import {
	ART_SIZES,
	COOKIE_BROWSERS,
	type CookieBrowser,
	EXISTING_FILE_MODES,
	MAX_CONCURRENCY,
	type ArtSize,
	type ExistingFileMode,
	type Settings
} from '$lib/settings';
import { cookieStatus, importFromBrowser, parseCookies, removeCookies, saveCookies } from '$lib/server/cookies';
import { checkLibraryDir, readSettings, saveSettings } from '$lib/server/settings';
import { listUsers } from '$lib/server/system-users';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [settings, users, cookies] = await Promise.all([readSettings(), listUsers(), cookieStatus()]);
	return { settings, users, cookies, libraryError: await checkLibraryDir(settings.libraryDir) };
};

export const actions: Actions = {
	save: async ({ request }) => {
		const form = await request.formData();
		const str = (k: string) => String(form.get(k) ?? '').trim();
		const errors: Partial<Record<keyof Settings, string>> = {};

		const libraryDir = str('libraryDir').replace(/\/+$/, '') || '/';
		const libraryError = await checkLibraryDir(libraryDir);
		if (libraryError) errors.libraryDir = libraryError;

		const concurrency = Number(str('concurrency'));
		if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
			errors.concurrency = `Enter a whole number from 1 to ${MAX_CONCURRENCY}.`;
		}

		const mbContact = str('mbContact');
		if (mbContact && !/^\S+@\S+\.\S+$/.test(mbContact) && !/^https?:\/\/\S+$/.test(mbContact)) {
			errors.mbContact = 'Enter an email address or a URL.';
		}

		// "auto" = same owner as the music folder; otherwise must be a listed user.
		let owner: Settings['owner'] = null;
		const ownerValue = str('owner');
		if (ownerValue !== 'auto') {
			const uid = Number(ownerValue);
			const user = (await listUsers()).find((u) => u.uid === uid);
			if (user) owner = { uid: user.uid, gid: user.gid };
			else errors.owner = 'Pick a user from the list.';
		}

		const existingFiles = str('existingFiles') as ExistingFileMode;
		if (!EXISTING_FILE_MODES.includes(existingFiles)) errors.existingFiles = 'Pick an option.';

		const artSize = Number(str('artSize')) as ArtSize;
		if (!ART_SIZES.includes(artSize)) errors.artSize = 'Pick a size.';

		if (Object.keys(errors).length) return fail(400, { errors });

		await saveSettings({
			...(await readSettings()), // keep the cookie-browser fields, saved by their own form
			libraryDir,
			concurrency,
			mbContact,
			owner,
			existingFiles,
			artSize
		});
		return { saved: true };
	},

	cookies: async ({ request }) => {
		const form = await request.formData();
		const file = form.get('cookiesFile');
		const pasted = String(form.get('cookiesText') ?? '');
		const text = file instanceof File && file.size > 0 ? await file.text() : pasted;

		const parsed = parseCookies(text);
		if ('error' in parsed) return fail(400, { cookiesError: parsed.error });
		await saveCookies(text);
		return { cookiesSaved: true };
	},

	cookiesFromBrowser: async ({ request }) => {
		const form = await request.formData();
		const browser = String(form.get('browser') ?? '') as CookieBrowser | '';
		const profile = String(form.get('profile') ?? '').trim();
		const autoRefresh = form.get('autoRefresh') === 'true';

		if (browser !== '' && !COOKIE_BROWSERS.includes(browser)) {
			return fail(400, { browserError: 'Pick a browser from the list.' });
		}
		// yt-dlp reads "browser:profile::container"; a colon in the profile would change its meaning.
		if (profile.includes(':')) return fail(400, { browserError: 'Profile names cannot contain ":".' });

		if (browser) {
			try {
				await importFromBrowser(browser, profile);
			} catch (err) {
				return fail(400, { browserError: (err as Error).message });
			}
		}
		await saveSettings({
			...(await readSettings()),
			cookieBrowser: browser,
			cookieProfile: profile,
			cookieAutoRefresh: browser ? autoRefresh : false
		});
		return { browserImported: !!browser };
	},

	removeCookies: async () => {
		await removeCookies();
		return { cookiesRemoved: true };
	}
};
