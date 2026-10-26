/**
 * Display of leave amounts (pure, shared by server and UI). Balances are stored as integer half-days; people read
 * days with an optional ".5".
 */

/** `3`, `1.5`, `-0.5` from half-days. */
export function formatDays(halfDays: number): string {
	const sign = halfDays < 0 ? '-' : '';
	const abs = Math.abs(halfDays);
	return `${sign}${Math.floor(abs / 2)}${abs % 2 ? '.5' : ''}`;
}

/** `1 day`, `2.5 days`. */
export const daysLabel = (halfDays: number): string =>
	`${formatDays(halfDays)} ${halfDays === 2 || halfDays === -2 ? 'day' : 'days'}`;

/** A date range for people: `2026-03-02` or `2026-03-02 – 2026-03-06`. */
export const rangeLabel = (startOn: string, endOn: string): string =>
	startOn === endOn ? startOn : `${startOn} – ${endOn}`;

/** ISO weekday names, Monday first. */
export const WEEKDAY_NAMES = [
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
	'Sunday'
] as const;
