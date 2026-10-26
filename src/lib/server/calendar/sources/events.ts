import { CAL_LIMITS, expandEvent, type DateRange } from '#lib/shared/calendar';
import type { Db } from '../../db';
import { eventsInWindow } from '../../events/repo';
import { toTiming } from '../../events/timing';
import type { SourceResult } from '../types';

/**
 * Events (PRD › Sources, `event`): the visible live events touching the window, expanded into their instances there
 * (never stored), at most CAL_LIMITS.expandMax per event and CAL_LIMITS.mergedMax in all. Two queries.
 */
export async function eventItems(
	db: Db,
	viewerId: string,
	range: DateRange,
	options: { projectId: string | null; mine: boolean; zone: string }
): Promise<SourceResult> {
	const { rows, exceptions } = await eventsInWindow(db, viewerId, range.from, range.to, {
		projectId: options.projectId,
		mine: options.mine,
		max: CAL_LIMITS.sourceMax + 1
	});
	let capped = rows.length > CAL_LIMITS.sourceMax;
	const items: SourceResult['items'] = [];
	for (const ev of rows.slice(0, CAL_LIMITS.sourceMax)) {
		const timing = toTiming(ev);
		const left = CAL_LIMITS.mergedMax - items.length;
		const instances = expandEvent(
			timing,
			range.from,
			range.to,
			exceptions.get(ev.id) ?? new Set(),
			options.zone,
			Math.min(CAL_LIMITS.expandMax, left + 1)
		);
		if (instances.length > left) {
			capped = true;
			instances.length = left;
		}
		for (const o of instances)
			items.push({
				kind: 'event',
				key: `event-${ev.id}-${o.onDate}`,
				title: ev.title,
				href: `/calendar/events/${ev.id}${timing.recFreq ? `?on=${o.onDate}` : ''}`,
				allDay: timing.allDay,
				startOn: o.onDate,
				endOn: o.endDate,
				startAt: timing.allDay ? null : o.startAt,
				endAt: timing.allDay ? null : o.endAt,
				overdue: false,
				done: false,
				private: ev.visibility === 'private'
			});
		if (items.length >= CAL_LIMITS.mergedMax) break;
	}
	return { items, capped };
}
