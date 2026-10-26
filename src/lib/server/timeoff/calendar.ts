import type { HalfDayPart } from '#lib/shared/enums';

/**
 * Leave date arithmetic (pure). Dates are calendar dates `YYYY-MM-DD` in TEAM_TIME_ZONE; they are handled as UTC
 * day numbers (`Date.UTC`), never through the runtime's local time zone, so a request counts the same everywhere.
 * Balances are whole half-days: a full working day is 2, a morning or afternoon 1.
 */

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of a valid `YYYY-MM-DD` (callers validate first). */
export function dayNumber(date: string): number {
	const m = DATE_RE.exec(date);
	if (!m) throw new Error('not a calendar date');
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

/** The `YYYY-MM-DD` of a day number. */
export const dateOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

export const addDays = (date: string, days: number): string => dateOf(dayNumber(date) + days);

/** ISO weekday: Monday 1 … Sunday 7. */
export function isoWeekday(date: string): number {
	const d = new Date(dayNumber(date) * DAY_MS).getUTCDay();
	return d === 0 ? 7 : d;
}

/** The calendar year of a date. */
export const yearOf = (date: string): number => Number(date.slice(0, 4));

/** Days from `start` to `end` inclusive (1 for a single date). */
export const spanDays = (start: string, end: string): number =>
	dayNumber(end) - dayNumber(start) + 1;

export interface HolidayDay {
	onDate: string;
	deductsLeave: boolean;
}

/** What one date is for leave counting. */
export type DayKind = 'work' | 'weekend' | 'holiday';

export function dayKind(
	date: string,
	workDays: readonly number[],
	holidays: ReadonlyMap<string, HolidayDay>
): DayKind {
	if (!workDays.includes(isoWeekday(date))) return 'weekend';
	const holiday = holidays.get(date);
	// A holiday that deducts leave is a working day for leave counting; one that does not is skipped.
	if (holiday && !holiday.deductsLeave) return 'holiday';
	return 'work';
}

export const holidayMap = (list: readonly HolidayDay[]): Map<string, HolidayDay> =>
	new Map(list.map((h) => [h.onDate, h]));

export interface CountInput {
	startOn: string;
	endOn: string;
	halfDay: HalfDayPart;
	workDays: readonly number[];
	holidays: readonly HolidayDay[];
}

export interface CountResult {
	halfDays: number;
	skipped: { weekends: number; holidays: number };
}

/**
 * Half-days a request uses: 2 per working day in `[startOn, endOn]`, 1 for a single-date `am`/`pm` request.
 * Non-work weekdays count as weekends, holidays with `deducts_leave = 0` on a work day as skipped holidays.
 * Callers bound the span (at most 366 days) before calling.
 */
export function countHalfDays(input: CountInput): CountResult {
	const map = holidayMap(input.holidays);
	const first = dayNumber(input.startOn);
	const last = dayNumber(input.endOn);
	let halfDays = 0;
	let weekends = 0;
	let skippedHolidays = 0;
	for (let day = first; day <= last; day += 1) {
		const kind = dayKind(dateOf(day), input.workDays, map);
		if (kind === 'weekend') weekends += 1;
		else if (kind === 'holiday') skippedHolidays += 1;
		else halfDays += 2;
	}
	if (first === last && input.halfDay !== 'none' && halfDays === 2) halfDays = 1;
	return { halfDays, skipped: { weekends, holidays: skippedHolidays } };
}

/** `YYYY-MM` of a date. */
export const monthOf = (date: string): string => date.slice(0, 7);

/** `YYYY-MM` shifted by `delta` months. */
export function addMonths(month: string, delta: number): string {
	const [y, m] = month.split('-').map(Number) as [number, number];
	const index = y * 12 + (m - 1) + delta;
	return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Whole months from `a` to `b` (`YYYY-MM`), negative when `b` is earlier. */
export function monthsBetween(a: string, b: string): number {
	const [ay, am] = a.split('-').map(Number) as [number, number];
	const [by, bm] = b.split('-').map(Number) as [number, number];
	return by * 12 + bm - (ay * 12 + am);
}

/** First and last date of a month `YYYY-MM`. */
export function monthRange(month: string): { first: string; last: string } {
	const first = `${month}-01`;
	return { first, last: addDays(`${addMonths(month, 1)}-01`, -1) };
}

/**
 * The month grid Monday to Sunday: whole weeks covering the month, each cell a date or null (outside the month).
 */
export function monthWeeks(month: string): (string | null)[][] {
	const { first, last } = monthRange(month);
	const lead = isoWeekday(first) - 1;
	const cells: (string | null)[] = Array<string | null>(lead).fill(null);
	for (let day = dayNumber(first); day <= dayNumber(last); day += 1) cells.push(dateOf(day));
	while (cells.length % 7) cells.push(null);
	const weeks: (string | null)[][] = [];
	for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
	return weeks;
}
