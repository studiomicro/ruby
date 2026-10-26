import { CAL_LIMITS, datesIn, type DateRange } from './calendar';

/** One thing on the calendar, from any source (RB-09 PRD › Sources). Every text is plain text. */
export interface CalendarItem {
	kind: 'task' | 'milestone' | 'event' | 'timeoff';
	/** Unique within one calendar response (kind, id and, for a series, the occurrence date). */
	key: string;
	title: string;
	/** A path on this site, or null (time off links nowhere). */
	href: string | null;
	allDay: boolean;
	/** Inclusive team dates the item covers. */
	startOn: string;
	endOn: string;
	/** Timed items: UTC ms. */
	startAt: number | null;
	endAt: number | null;
	overdue: boolean;
	done: boolean;
	private: boolean;
}

/** Within one day: all-day first, then timed by start, then by title. */
export function compareInDay(a: CalendarItem, b: CalendarItem): number {
	if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
	if ((a.startAt ?? 0) !== (b.startAt ?? 0)) return (a.startAt ?? 0) - (b.startAt ?? 0);
	return a.title.localeCompare(b.title) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** By first day, then as within a day. */
export const compareItems = (a: CalendarItem, b: CalendarItem): number =>
	a.startOn !== b.startOn ? (a.startOn < b.startOn ? -1 : 1) : compareInDay(a, b);

export interface CalendarDay {
	date: string;
	items: CalendarItem[];
}

/** Every day of `range` with the items touching it (a multi-day item on each of its days), in display order. */
export function groupByDay(items: readonly CalendarItem[], range: DateRange): CalendarDay[] {
	const days = new Map<string, CalendarItem[]>(datesIn(range.from, range.to).map((d) => [d, []]));
	for (const item of items) {
		const from = item.startOn < range.from ? range.from : item.startOn;
		const to = item.endOn > range.to ? range.to : item.endOn;
		for (const d of datesIn(from, to, CAL_LIMITS.windowMaxDays)) days.get(d)?.push(item);
	}
	return [...days].map(([date, list]) => ({ date, items: list.sort(compareInDay) }));
}
