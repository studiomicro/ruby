import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { teamZone, zoneContext } from '#lib/server/calendar/zone';
import {
	canManageEvent,
	deleteEvent,
	deleteOccurrence,
	isOccurrenceRemoved
} from '#lib/server/events/repo';
import { eventFromParams, writeRefusal } from '#lib/server/events/route';
import { readFormBody, textField } from '#lib/server/forms';
import { reminderActions, reminderPanel } from '#lib/server/reminders/panel';
import { now } from '#lib/server/util';
import { isDate, occurrenceOn } from '#lib/shared/calendar';
import type { Actions, PageServerLoad } from './$types';

/**
 * One event: details (description through the one Markdown renderer), attendees, the viewer's reminders, delete
 * (whole event or series, or one occurrence) for its creator or an admin. `?on=<date>` names one occurrence.
 */
export const load: PageServerLoad = async (event) => {
	const { user, ev } = await eventFromParams(event);
	const zone = teamZone();
	const rawOn = event.url.searchParams.get('on') ?? '';
	const on = ev.recFreq && isDate(rawOn) && occurrenceOn(ev, rawOn, zone) ? rawOn : null;
	const [reminders, removed] = await Promise.all([
		reminderPanel(event.locals.db, user, { kind: 'event', id: ev.id }),
		on ? isOccurrenceRemoved(event.locals.db, ev.id, on) : false
	]);
	return {
		ev,
		on,
		occurrence: on ? occurrenceOn(ev, on, zone) : null,
		occurrenceRemoved: removed,
		reminders,
		canManage: canManageEvent(user, ev),
		created: event.url.searchParams.has('created'),
		saved: event.url.searchParams.has('saved'),
		clock: zoneContext()
	};
};

async function host(event: RequestEvent) {
	const { ev } = await eventFromParams(event);
	return { kind: 'event' as const, id: ev.id };
}

export const actions: Actions = {
	...reminderActions(host),

	/** The whole event (or series): creator or admin, after ticking the confirmation. */
	remove: async (event) => {
		const { user, ev } = await eventFromParams(event);
		if (!canManageEvent(user, ev))
			error(403, 'Only the event’s creator or an admin can delete it.');
		const form = await readFormBody(event.request);
		if (textField(form, 'confirm') !== 'yes')
			return fail(400, { removeError: 'Tick the box to confirm.' });
		const result = await deleteEvent(event.locals.db, user, ev.id, now());
		if (!result.ok) writeRefusal(result);
		redirect(303, '/calendar?deleted=1');
	},

	/** One occurrence of a series (`on`): creator or admin. */
	removeOccurrence: async (event) => {
		const { user, ev } = await eventFromParams(event);
		if (!canManageEvent(user, ev))
			error(403, 'Only the event’s creator or an admin can delete it.');
		const form = await readFormBody(event.request);
		const on = textField(form, 'on');
		if (!ev.recFreq || !isDate(on) || !occurrenceOn(ev, on, teamZone()))
			return fail(400, { removeError: 'That occurrence does not exist.' });
		const result = await deleteOccurrence(event.locals.db, user, ev.id, on, now());
		if (!result.ok) writeRefusal(result);
		redirect(303, `/calendar/events/${ev.id}?on=${on}`);
	}
};
