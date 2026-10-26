import { error, fail, type RequestEvent } from '@sveltejs/kit';
import {
	EVENT_REMINDER_PRESETS,
	isDate,
	isTime,
	MINUTE_MS,
	offsetLabel,
	REMINDER_LIMITS,
	TASK_ANCHOR_TIME,
	TASK_REMINDER_PRESETS,
	zonedToUtc
} from '#lib/shared/calendar';
import type { ReminderOutcome } from '#lib/shared/enums';
import type { SessionUser } from '../auth/session';
import { teamZone } from '../calendar/zone';
import type { Db } from '../db';
import { readFormBody, textField } from '../forms';
import { requireUser } from '../guards';
import { isUuid } from '../tasks/validation';
import { now } from '../util';
import {
	createReminder,
	deleteReminder,
	listTargetReminders,
	REMINDER_MESSAGES,
	type ReminderRequest
} from './repo';

/**
 * The "Reminders" panel of a task or event page and its two form actions, `?/reminderAdd` and `?/reminderRemove`
 * (RB-09 PRD › Reminders). Every reminder shown and changed is the viewer's own. The host resolves its live,
 * visible target fresh for every action (its own 404 otherwise). Results come back under the `reminder` key so they
 * never collide with the host page's form data.
 */

export interface ReminderHost {
	kind: 'task' | 'event';
	id: string;
	/** Tasks: the live due date (relative presets need one). */
	dueOn?: string | null;
}

export interface PanelReminder {
	id: string;
	label: string;
	/** When it fires (or fired): UTC ms. */
	at: number;
	pending: boolean;
	outcome: ReminderOutcome | null;
}

export interface ReminderPanel {
	kind: 'task' | 'event';
	reminders: PanelReminder[];
	presets: { offset: number; label: string }[];
	/** Tasks: relative presets need a due date. */
	noDueDate: boolean;
	atLimit: boolean;
}

export async function reminderPanel(
	db: Db,
	user: Pick<SessionUser, 'id'>,
	host: ReminderHost
): Promise<ReminderPanel> {
	const zone = teamZone();
	const rows = await listTargetReminders(db, user.id, host.kind, host.id);
	const reminders = rows.map((r) => {
		// A pending relative task reminder shows the time derived from the live due date: right after a due-date edit
		// the stored fire_at is "now" until the jobs Worker re-derives it.
		const derived =
			host.kind === 'task' && r.mode === 'relative' && host.dueOn && r.doneAt === null
				? zonedToUtc(host.dueOn, TASK_ANCHOR_TIME, zone) - (r.offsetMin ?? 0) * MINUTE_MS
				: null;
		return {
			id: r.id,
			label: r.mode === 'relative' ? offsetLabel(host.kind, r.offsetMin ?? 0) : 'At a set time',
			at: derived ?? r.fireAt,
			pending: r.doneAt === null,
			outcome: r.outcome
		};
	});
	return {
		kind: host.kind,
		reminders,
		presets: [...(host.kind === 'task' ? TASK_REMINDER_PRESETS : EVENT_REMINDER_PRESETS)],
		noDueDate: host.kind === 'task' && !host.dueOn,
		atLimit: reminders.filter((r) => r.pending).length >= REMINDER_LIMITS.perTarget
	};
}

/** `date` + `time` in the team zone as UTC ms, or null when either is not a valid value. */
export function parseWhen(date: string, time: string, zone: string): number | null {
	return isDate(date) && isTime(time) ? zonedToUtc(date, time, zone) : null;
}

const refuse = (status: number, message: string) => fail(status, { reminder: { error: message } });

export function reminderActions<E extends RequestEvent>(host: (event: E) => Promise<ReminderHost>) {
	return {
		reminderAdd: async (event: E) => {
			const user = requireUser(event);
			const target = await host(event);
			const form = await readFormBody(event.request);
			const zone = teamZone();
			const presets: readonly { offset: number }[] =
				target.kind === 'task' ? TASK_REMINDER_PRESETS : EVENT_REMINDER_PRESETS;
			let req: ReminderRequest;
			if (textField(form, 'mode') === 'absolute' && target.kind === 'task') {
				const at = parseWhen(textField(form, 'date'), textField(form, 'time'), zone);
				if (at === null) return refuse(400, REMINDER_MESSAGES.when);
				req = { kind: 'task', taskId: target.id, mode: 'absolute', remindAt: at };
			} else {
				const raw = textField(form, 'offset');
				const offset = /^\d{1,5}$/.test(raw) ? Number(raw) : -1;
				if (!presets.some((p) => p.offset === offset)) return refuse(400, REMINDER_MESSAGES.offset);
				req =
					target.kind === 'task'
						? { kind: 'task', taskId: target.id, mode: 'relative', offset }
						: { kind: 'event', eventId: target.id, offset };
			}
			const result = await createReminder(event.locals.db, user.id, req, now(), zone);
			if (result.ok) return { reminder: { added: true } };
			if (result.reason === 'not_found') error(404, REMINDER_MESSAGES.not_found);
			return refuse(
				result.reason === 'daily_limit' ? 429 : result.reason.endsWith('limit') ? 409 : 400,
				REMINDER_MESSAGES[result.reason]
			);
		},

		reminderRemove: async (event: E) => {
			const user = requireUser(event);
			await host(event);
			const form = await readFormBody(event.request);
			const id = textField(form, 'id');
			if (!isUuid(id) || !(await deleteReminder(event.locals.db, user.id, id.toLowerCase(), now())))
				error(404, REMINDER_MESSAGES.notFound);
			return { reminder: { removed: true } };
		}
	};
}
