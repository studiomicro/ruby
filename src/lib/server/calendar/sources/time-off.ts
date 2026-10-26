import { CAL_LIMITS, datesIn, maxDate, minDate, type DateRange } from '#lib/shared/calendar';
import type { HalfDayPart } from '#lib/shared/enums';
import type { Db } from '../../db';
import { dayKind, holidayMap } from '../../timeoff/calendar';
import { getWorkDays, listHolidays } from '../../timeoff/repo';
import type { CalendarItem } from '../types';
import type { SourceResult } from '../types';

/**
 * RB-06 time off on the calendar (PRD › Sources, `timeoff`; owner decision O9), with RB-06's own team-calendar
 * privacy (timeoff/repo.ts › calendarMonth): public holidays by name, and who is out — the person's name and the
 * part of the day only, on the work days of an APPROVED request. Never the leave type, the reason, the status, a
 * request id or a pending, rejected or canceled request. No link. Every active user sees it, as on /time-off.
 */
const PART: Record<HalfDayPart, string> = { none: '', am: ' am', pm: ' pm' };

export async function timeOffItems(db: Db, range: DateRange): Promise<SourceResult> {
	const [{ days: workDays }, holidays, { results }] = await Promise.all([
		getWorkDays(db),
		listHolidays(db, range.from, range.to),
		db.$client
			.prepare(
				`SELECT r.start_on AS startOn, r.end_on AS endOn, r.half_day AS halfDay, e.full_name AS name
				 FROM leave_requests r JOIN employees e ON e.id = r.employee_id AND e.deleted_at IS NULL
				 WHERE r.status = 'approved' AND r.start_on <= ?2 AND r.end_on >= ?1
				 ORDER BY lower(e.full_name), r.start_on LIMIT ?3`
			)
			.bind(range.from, range.to, CAL_LIMITS.sourceMax + 1)
			.all<{ startOn: string; endOn: string; halfDay: HalfDayPart; name: string }>()
	]);
	const map = holidayMap(holidays);
	const item = (key: string, title: string, on: string): CalendarItem => ({
		kind: 'timeoff',
		key,
		title,
		href: null,
		allDay: true,
		startOn: on,
		endOn: on,
		startAt: null,
		endAt: null,
		overdue: false,
		done: false,
		private: false
	});
	const items: CalendarItem[] = holidays.map((h) => item(`holiday-${h.onDate}`, h.name, h.onDate));
	results.slice(0, CAL_LIMITS.sourceMax).forEach((r, i) => {
		const part = r.startOn === r.endOn ? PART[r.halfDay] : '';
		for (const date of datesIn(maxDate(r.startOn, range.from), minDate(r.endOn, range.to)))
			if (dayKind(date, workDays, map) === 'work')
				items.push(item(`out-${i}-${date}`, `${r.name} (out${part})`, date));
	});
	return { items, capped: results.length > CAL_LIMITS.sourceMax };
}
