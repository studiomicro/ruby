import { requireViewer } from '#lib/server/hr/access';
import { addMonths, monthOf, monthsBetween } from '#lib/server/timeoff/calendar';
import { calendarMonth } from '#lib/server/timeoff/repo';
import { LEAVE_LIMITS } from '#lib/server/timeoff/validation';
import { teamToday } from '#lib/server/tasks/today';
import type { PageServerLoad } from './$types';

/**
 * Who is out, one month (`?month=YYYY-MM`, clamped to 12 months around this one) for every active user: approved
 * leave as names and day parts only, plus holidays. Never the leave type, the reason, pending or rejected leave.
 */
export const load: PageServerLoad = async (event) => {
	await requireViewer(event);
	const today = teamToday();
	const current = monthOf(today);
	const raw = event.url.searchParams.get('month') ?? '';
	const max = LEAVE_LIMITS.calendarMonthsAround;
	let month = /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : current;
	const offset = monthsBetween(current, month);
	if (offset > max) month = addMonths(current, max);
	if (offset < -max) month = addMonths(current, -max);
	const { weeks, truncated } = await calendarMonth(event.locals.db, month);
	const shift = monthsBetween(current, month);
	return {
		month,
		today,
		weeks,
		truncated,
		prev: shift > -max ? addMonths(month, -1) : null,
		next: shift < max ? addMonths(month, 1) : null,
		current
	};
};
