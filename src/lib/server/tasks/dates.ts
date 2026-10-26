/**
 * Due dates are calendar dates (`YYYY-MM-DD`, no time zone). "Today" is the team's date in TEAM_TIME_ZONE
 * (owner decision 3), so a task due today is not overdue for anyone in the team before the team's midnight.
 */

const DUE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const DUE_MIN = '2000-01-01';
export const DUE_MAX = '2100-12-31';

/** A real calendar date in `YYYY-MM-DD` form between `min` and `max` inclusive (2026-02-30 and 2026-1-1 are not). */
export function isCalendarDate(s: string, min: string, max: string): boolean {
	const m = DUE_RE.exec(s);
	if (!m) return false;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const date = new Date(Date.UTC(y, mo - 1, d));
	const roundTrips =
		date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
	return roundTrips && s >= min && s <= max;
}

/** A real calendar date in `YYYY-MM-DD` form between DUE_MIN and DUE_MAX. */
export const isValidDueOn = (s: string): boolean => isCalendarDate(s, DUE_MIN, DUE_MAX);

/** The calendar date at instant `now` (UTC ms) in IANA zone `zone`; an unknown zone falls back to UTC. */
export function todayIn(zone: string | undefined, now: number): string {
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat('en-US', {
			timeZone: zone || 'UTC',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit'
		}).formatToParts(now);
	} catch {
		return new Date(now).toISOString().slice(0, 10);
	}
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}

export type DueBucket = 'overdue' | 'today' | 'upcoming' | 'none';

/** Where a due date falls relative to `today` (both `YYYY-MM-DD`, which compare as strings). */
export function dueBucket(dueOn: string | null, today: string): DueBucket {
	if (!dueOn) return 'none';
	if (dueOn < today) return 'overdue';
	return dueOn === today ? 'today' : 'upcoming';
}
