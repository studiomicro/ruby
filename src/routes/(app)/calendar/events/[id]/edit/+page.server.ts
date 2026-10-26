import { error, fail, redirect } from '@sveltejs/kit';
import { teamZone, zoneContext } from '#lib/server/calendar/zone';
import { canManageEvent, updateEvent } from '#lib/server/events/repo';
import { eventFromParams, formChoices, writeRefusal } from '#lib/server/events/route';
import {
	EVENT_MESSAGES,
	formValues,
	parseEventForm,
	valuesOfEvent
} from '#lib/server/events/validation';
import { readFormBody, textField } from '#lib/server/forms';
import { parseExpected } from '#lib/server/tasks/validation';
import { now } from '#lib/server/util';
import { utcToZoned } from '#lib/shared/calendar';
import type { Actions, PageServerLoad } from './$types';

const EVENT_FORM_MAX = 64 * 1024;

/** Edits the whole event (series included): its creator or an admin; anyone else who can see it gets 403. */
export const load: PageServerLoad = async (event) => {
	const { user, ev } = await eventFromParams(event);
	if (!canManageEvent(user, ev)) error(403, EVENT_MESSAGES.notAllowed);
	const zone = teamZone();
	return {
		...(await formChoices(event.locals.db)),
		clock: zoneContext(),
		id: ev.id,
		title: ev.title,
		updatedAt: ev.updatedAt,
		initial: valuesOfEvent({ ...ev, attendeeIds: ev.attendees.map((a) => a.id) }, (at) =>
			utcToZoned(at, zone)
		)
	};
};

export const actions: Actions = {
	/** Saves against the version the form was loaded from; a newer save meanwhile answers 409 and keeps the text. */
	update: async (event) => {
		const { user, ev } = await eventFromParams(event);
		if (!canManageEvent(user, ev)) error(403, EVENT_MESSAGES.notAllowed);
		const form = await readFormBody(event.request, EVENT_FORM_MAX);
		const expected = parseExpected(textField(form, 'expectedUpdatedAt'));
		if (expected === null)
			return fail(400, { errors: { form: EVENT_MESSAGES.conflict }, values: formValues(form) });
		const parsed = parseEventForm(form, teamZone());
		if (!parsed.ok) return fail(400, { errors: parsed.errors, values: parsed.values, expected });
		const result = await updateEvent(event.locals.db, user, ev.id, parsed.value, expected, now());
		if (result.ok) redirect(303, `/calendar/events/${ev.id}?saved=1`);
		const refused = writeRefusal(result);
		return fail(refused.status, {
			errors: refused.errors,
			values: formValues(form),
			expected,
			conflict: refused.conflict ?? false
		});
	}
};
