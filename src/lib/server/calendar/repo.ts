import {
	CAL_LIMITS,
	type CalendarFilter,
	type CalendarSource,
	type DateRange
} from '#lib/shared/calendar';
import { compareItems } from '#lib/shared/calendar-items';
import type { Db } from '../db';
import { eventItems } from './sources/events';
import { milestoneItems } from './sources/milestones';
import { taskItems } from './sources/tasks';
import { timeOffItems } from './sources/time-off';
import type { CalendarItem, SourceResult } from './types';

/**
 * The calendar aggregator (RB-09 PRD › Calendar): every shown source for one window, merged and sorted, at most
 * CAL_LIMITS.mergedMax items. Each source is a fixed number of indexed range queries, so a page load costs the same
 * number of queries whatever the item count.
 */

/** Every source: tasks, RB-08 milestones, events and RB-06 time off. */
export const AVAILABLE_SOURCES: readonly CalendarSource[] = [
	'tasks',
	'milestones',
	'events',
	'timeoff'
];

export interface CalendarData {
	items: CalendarItem[];
	/** A source hit its cap: "Some items are not shown; narrow the filters". */
	capped: boolean;
}

export async function loadCalendar(
	db: Db,
	viewerId: string,
	filter: CalendarFilter,
	window: DateRange,
	context: { projectId: string | null; today: string; zone: string }
): Promise<CalendarData> {
	const shown = new Set(filter.show);
	const empty: SourceResult = { items: [], capped: false };
	const results = await Promise.all([
		shown.has('tasks')
			? taskItems(db, viewerId, window, {
					scope: filter.tasks === 'mine' ? 'mine' : 'all',
					projectId: context.projectId,
					done: filter.done,
					today: context.today
				})
			: empty,
		shown.has('events')
			? eventItems(db, viewerId, window, {
					projectId: context.projectId,
					mine: filter.mine,
					zone: context.zone
				})
			: empty,
		shown.has('milestones')
			? milestoneItems(db, window, { projectId: context.projectId, done: filter.done })
			: empty,
		shown.has('timeoff') ? timeOffItems(db, window) : empty
	]);
	const all = results.flatMap((r) => r.items).sort(compareItems);
	return {
		items: all.slice(0, CAL_LIMITS.mergedMax),
		capped: results.some((r) => r.capped) || all.length > CAL_LIMITS.mergedMax
	};
}
