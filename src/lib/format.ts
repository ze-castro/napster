const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** "just now", "5 min ago", "3 h ago", "yesterday", then a date. */
export function timeAgo(timestamp: number, now = Date.now()): string {
	const minutes = Math.floor((now - timestamp) / 60000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	if (hours < 48) return 'yesterday';
	return dateFormat.format(timestamp);
}
