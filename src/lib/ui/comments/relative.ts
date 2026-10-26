/**
 * A past moment as a short relative phrase ("just now", "5 min ago", "3 h ago", "2 days ago"); past 30 days, null
 * (the caller shows the date instead). A future `at` (clock skew) reads "just now". Pure.
 */
export function relativeTime(at: number, now: number): string | null {
	const seconds = Math.max(0, Math.floor((now - at) / 1000));
	if (seconds < 45) return 'just now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days <= 30) return days === 1 ? 'yesterday' : `${days} days ago`;
	return null;
}
