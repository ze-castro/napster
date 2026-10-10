export type Theme = 'system' | 'light' | 'dark';
const ORDER: Theme[] = ['system', 'light', 'dark'];

function stored(): Theme {
	try {
		const t = localStorage.getItem('theme');
		return t === 'light' || t === 'dark' ? t : 'system';
	} catch {
		return 'system';
	}
}

/** Light, dark, or whatever the device says. The first paint is handled in app.html. */
export const theme = $state<{ value: Theme }>({ value: 'system' });

function apply() {
	const dark =
		theme.value === 'dark' || (theme.value === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
	document.documentElement.classList.toggle('dark', dark);
}

export function cycleTheme() {
	theme.value = ORDER[(ORDER.indexOf(theme.value) + 1) % ORDER.length];
	try {
		if (theme.value === 'system') localStorage.removeItem('theme');
		else localStorage.setItem('theme', theme.value);
	} catch {
		// private mode: the choice lasts until the tab closes
	}
	apply();
}

/**
 * Reads the saved choice and follows the device while set to "system".
 * Call once from the root layout's effect (the server always renders "system").
 */
export function watchSystemTheme(): () => void {
	theme.value = stored();
	const media = matchMedia('(prefers-color-scheme: dark)');
	media.addEventListener('change', apply);
	return () => media.removeEventListener('change', apply);
}
