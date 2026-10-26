import { sql } from 'drizzle-orm';
import type { SessionUser } from '#lib/server/auth/session';
import type { Db } from '#lib/server/db';
import { createEvent } from '#lib/server/events/repo';
import type { EventInput } from '#lib/server/events/validation';
import { eventSpan, zonedToUtc } from '#lib/shared/calendar';

/** RB-09 fixtures: fictional events written through the real repository. */

export const JKT = 'Asia/Jakarta';
/** A team-zone instant: `at('2026-11-02', '14:00')`. */
export const at = (date: string, time: string) => zonedToUtc(date, time, JKT);

export function eventInput(overrides: Partial<EventInput> = {}): EventInput {
	const base = {
		title: 'Fictional sync',
		description: '',
		location: '',
		allDay: false,
		startOn: null,
		endOn: null,
		startAt: at('2026-11-02', '14:00'),
		endAt: at('2026-11-02', '15:00'),
		projectId: null,
		visibility: 'team' as const,
		attendeeIds: [],
		recFreq: null,
		recInterval: 1,
		recUntilOn: null,
		...overrides
	};
	return { ...base, ...eventSpan(base, JKT) };
}

export async function seedEvent(
	db: Db,
	actor: SessionUser,
	overrides: Partial<EventInput> = {},
	now = Date.now()
): Promise<string> {
	const created = await createEvent(db, actor, eventInput(overrides), now);
	if (!created.ok) throw new Error(`seedEvent failed: ${created.reason}`);
	return created.id;
}

/** Empties the RB-09 tables, then the RB-01 ones and the users (in foreign-key order). */
export async function clearCalendar(db: Db) {
	for (const table of [
		'notifications',
		'reminders',
		'event_exceptions',
		'event_attendees',
		'events',
		'user_calendar_prefs',
		'app_meta',
		'comments',
		'task_labels',
		'task_checklist_items',
		'saved_views',
		'project_columns',
		'labels',
		'tasks',
		'milestones',
		'projects',
		'leave_requests',
		'holidays',
		'employees',
		'sessions',
		'invites',
		'user_passwords',
		'auth_attempts'
	])
		await db.run(sql.raw(`delete from ${table}`));
	// hr_audit_log is append-only (an RB-09 events purge writes to it): the users it names stay.
	await db.run(
		sql.raw(
			`delete from users where id not in (select actor_id from hr_audit_log)
			   and id not in (select user_id from hr_audit_log where user_id is not null)`
		)
	);
}

export async function reminderRow(db: Db, id: string) {
	return db.$client
		.prepare(`SELECT * FROM reminders WHERE id = ?1`)
		.bind(id)
		.first<Record<string, unknown>>();
}

export async function reminderNotifications(db: Db, userId?: string) {
	const { results } = await db.$client
		.prepare(
			`SELECT * FROM notifications WHERE kind = 'reminder' AND (?1 IS NULL OR user_id = ?1) ORDER BY occurrence_at`
		)
		.bind(userId ?? null)
		.all<Record<string, unknown>>();
	return results;
}
