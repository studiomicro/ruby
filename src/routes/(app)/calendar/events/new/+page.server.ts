import { fail, redirect } from '@sveltejs/kit';
import { teamZone, zoneContext } from '#lib/server/calendar/zone';
import { createEvent } from '#lib/server/events/repo';
import { formChoices, writeRefusal } from '#lib/server/events/route';
import { formValues, parseEventForm } from '#lib/server/events/validation';
import { readFormBody } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { now } from '#lib/server/util';
import { isDate } from '#lib/shared/calendar';
import type { Actions, PageServerLoad } from './$types';

/** Event body cap: a 5000-character description URL-encoded, with room to spare. */
const EVENT_FORM_MAX = 64 * 1024;

export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const clock = zoneContext();
	const raw = event.url.searchParams.get('date') ?? '';
	const date = isDate(raw) ? raw : clock.today;
	return {
		...(await formChoices(event.locals.db)),
		clock,
		initial: {
			...formValues(new FormData()),
			startDate: date,
			endDate: date,
			startTime: '09:00',
			endTime: '10:00',
			visibility: 'team',
			repeat: 'none',
			interval: '1'
		}
	};
};

export const actions: Actions = {
	/** Creates the event (any active user); redirects to it once the server stored it. */
	create: async (event) => {
		const user = requireUser(event);
		const form = await readFormBody(event.request, EVENT_FORM_MAX);
		const parsed = parseEventForm(form, teamZone());
		if (!parsed.ok) return fail(400, { errors: parsed.errors, values: parsed.values });
		const result = await createEvent(event.locals.db, user, parsed.value, now());
		if (result.ok) redirect(303, `/calendar/events/${result.id}?created=1`);
		const refused = writeRefusal(result);
		return fail(refused.status, { errors: refused.errors, values: formValues(form) });
	}
};
