import { error, fail } from '@sveltejs/kit';
import { teamZone, zoneContext } from '#lib/server/calendar/zone';
import { readFormBody, textField } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { HEARTBEAT_STALE_MS } from '#lib/server/reminders/jobs';
import { parseWhen } from '#lib/server/reminders/panel';
import {
	createReminder,
	deleteReminder,
	jobsLastRun,
	listMyReminders,
	REMINDER_MESSAGES
} from '#lib/server/reminders/repo';
import { cleanLine, isUuid } from '#lib/server/tasks/validation';
import { now } from '#lib/server/util';
import { REMINDER_LIMITS } from '#lib/shared/calendar';
import type { Actions, PageServerLoad } from './$types';

/**
 * `/reminders`: the viewer's own reminders (pending and history) and personal reminders. Nobody else's reminders
 * are ever read here, admin included. A scheduler that has not run for 10 minutes shows a warning.
 */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const db = event.locals.db;
	const at = now();
	const [lists, lastRun] = await Promise.all([listMyReminders(db, user.id), jobsLastRun(db)]);
	return {
		...lists,
		schedulerLate:
			lastRun === null
				? null
				: at - lastRun > HEARTBEAT_STALE_MS
					? Math.floor((at - lastRun) / 60_000)
					: 0,
		clock: zoneContext(at)
	};
};

export const actions: Actions = {
	/** A personal reminder: a title and a team-zone date and time, at least a minute and at most two years ahead. */
	create: async (event) => {
		const user = requireUser(event);
		const form = await readFormBody(event.request);
		const rawTitle = textField(form, 'title');
		const values = {
			title: rawTitle.slice(0, REMINDER_LIMITS.titleMax * 4),
			date: textField(form, 'date').slice(0, 20),
			time: textField(form, 'time').slice(0, 10)
		};
		const title = cleanLine(rawTitle, REMINDER_LIMITS.titleMax);
		if (title.tooLong) return fail(400, { error: REMINDER_MESSAGES.titleLong, values });
		if (!title.value) return fail(400, { error: REMINDER_MESSAGES.title, values });
		const remindAt = parseWhen(values.date, values.time, teamZone());
		if (remindAt === null) return fail(400, { error: REMINDER_MESSAGES.when, values });
		const result = await createReminder(
			event.locals.db,
			user.id,
			{ kind: 'personal', title: title.value, remindAt },
			now(),
			teamZone()
		);
		if (!result.ok)
			return fail(
				result.reason === 'daily_limit' ? 429 : result.reason.endsWith('limit') ? 409 : 400,
				{
					error: REMINDER_MESSAGES[result.reason],
					values
				}
			);
		return { created: true };
	},

	/** One of the viewer's own reminders; anyone else's id answers 404 like a missing one. */
	remove: async (event) => {
		const user = requireUser(event);
		const form = await readFormBody(event.request);
		const id = textField(form, 'id');
		if (!isUuid(id) || !(await deleteReminder(event.locals.db, user.id, id.toLowerCase(), now())))
			error(404, REMINDER_MESSAGES.notFound);
		return { removed: true };
	}
};
