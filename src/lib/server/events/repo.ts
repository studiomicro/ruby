import { CAL_LIMITS, DAY_MS, addDays } from '#lib/shared/calendar';
import type { EventVisibility, RecFreq } from '#lib/shared/enums';
import type { SessionUser } from '../auth/session';
import type { Db } from '../db';
import { newId } from '../util';
import { eventLiveSql, eventVisibleSql, timingColumns, toTiming, type TimingRow } from './timing';
import type { EventInput } from './validation';

/**
 * Team and private events (RB-09 PRD › Events, Authorization, Concurrency). Raw, parameterised SQL through D1. Every
 * read is scoped to what the viewer may see (team events, or private ones they created or attend: an admin is no
 * exception), so a private event of someone else behaves exactly like a missing one. Every write is one guarded
 * statement or one `db.batch`: caps, project and attendee checks are part of the write itself.
 */

type Actor = Pick<SessionUser, 'id' | 'role'>;

const prep = (db: Db, query: string, ...params: unknown[]) =>
	db.$client.prepare(query).bind(...params);

export interface EventAttendee {
	id: string;
	name: string;
	active: boolean;
}

export interface EventDetail {
	id: string;
	title: string;
	description: string;
	location: string;
	allDay: boolean;
	startOn: string | null;
	endOn: string | null;
	startAt: number | null;
	endAt: number | null;
	visibility: EventVisibility;
	recFreq: RecFreq | null;
	recInterval: number;
	recUntilOn: string | null;
	projectId: string | null;
	projectKey: string | null;
	projectName: string | null;
	createdBy: string;
	createdByName: string | null;
	createdAt: number;
	updatedAt: number;
	attendees: EventAttendee[];
}

/** Display rule only (the writes check it again): the creator or an admin may edit and delete a visible event. */
export const canManageEvent = (user: Actor, ev: Pick<EventDetail, 'createdBy'>) =>
	user.role === 'admin' || ev.createdBy === user.id;

/** SQL: the actor may change event `e`. */
const manageSql = (e: string, meParam: string, adminParam: string) =>
	`(${adminParam} = 1 OR ${e}.created_by = ${meParam})`;

/** A live event `viewerId` may see, with its attendees, or null (missing, deleted and hidden look the same). */
export async function getVisibleEvent(
	db: Db,
	viewerId: string,
	id: string
): Promise<EventDetail | null> {
	const [main, attendees] = await db.$client.batch([
		prep(
			db,
			`SELECT e.id, e.title, e.description, e.location, e.visibility, e.project_id AS projectId,
				p.key AS projectKey, p.name AS projectName, e.created_by AS createdBy, u.name AS createdByName,
				e.created_at AS createdAt, e.updated_at AS updatedAt, ${timingColumns('e')}
			 FROM events e LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN users u ON u.id = e.created_by
			 WHERE e.id = ?1 AND ${eventLiveSql('e')} AND ${eventVisibleSql('e', '?2')}`,
			id,
			viewerId
		),
		prep(
			db,
			`SELECT u.id, u.name, u.status = 'active' AS active FROM event_attendees a
			 JOIN users u ON u.id = a.user_id JOIN events e ON e.id = a.event_id
			 WHERE a.event_id = ?1 AND ${eventVisibleSql('e', '?2')}
			 ORDER BY u.name LIMIT ${CAL_LIMITS.attendeesMax}`,
			id,
			viewerId
		)
	]);
	const row = main?.results[0] as
		| (TimingRow &
				Omit<EventDetail, 'allDay' | 'attendees' | 'recFreq'> & { recFreq: string | null })
		| undefined;
	if (!row) return null;
	const timing = toTiming(row);
	return {
		...row,
		...timing,
		attendees: ((attendees?.results ?? []) as { id: string; name: string; active: number }[]).map(
			(a) => ({ id: a.id, name: a.name, active: a.active === 1 })
		)
	};
}

/** Why a project or attendee list is refused, read before a write (the write checks again). */
export async function checkEventRefs(
	db: Db,
	input: Pick<EventInput, 'projectId' | 'attendeeIds'>
): Promise<{ projectId?: true; attendees?: true }> {
	const row = await prep(
		db,
		`SELECT
			(?1 IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = ?1 AND status = 'active' AND deleted_at IS NULL)) AS projectOk,
			(SELECT count(*) FROM users WHERE id IN (SELECT value FROM json_each(?2)) AND status = 'active') AS active`,
		input.projectId,
		JSON.stringify(input.attendeeIds)
	).first<{ projectOk: number; active: number }>();
	return {
		...(row?.projectOk ? {} : { projectId: true as const }),
		...((row?.active ?? 0) === input.attendeeIds.length ? {} : { attendees: true as const })
	};
}

/** SQL guards shared by create and update: the project is active and live, every attendee an active user. */
const refsSql = (projectParam: string, attendeesParam: string) =>
	`(${projectParam} IS NULL OR EXISTS (SELECT 1 FROM projects rp WHERE rp.id = ${projectParam} AND rp.status = 'active' AND rp.deleted_at IS NULL))
	 AND (SELECT count(*) FROM users ru WHERE ru.id IN (SELECT value FROM json_each(${attendeesParam})) AND ru.status = 'active') = json_array_length(${attendeesParam})`;

/** The creator attends implicitly and is never stored. */
const attendeesOf = (input: EventInput, creatorId: string) =>
	JSON.stringify(input.attendeeIds.filter((id) => id !== creatorId));

export type EventWrite<T = object> =
	| ({ ok: true } & T)
	| {
			ok: false;
			reason:
				| 'not_found'
				| 'forbidden'
				| 'conflict'
				| 'project'
				| 'attendees'
				| 'live_limit'
				| 'daily_limit';
	  };

/**
 * Creates an event and its attendees in one batch. The INSERT itself holds the caps (500 live events of this user,
 * 100 created by this user in 24 h: per creator, so nobody can fill the instance for everyone; red team L1), the
 * project and the attendee checks; the attendee rows go in only if the event row exists.
 */
export async function createEvent(
	db: Db,
	actor: Actor,
	input: EventInput,
	at: number
): Promise<EventWrite<{ id: string }>> {
	const id = newId();
	const attendees = attendeesOf(input, actor.id);
	const [inserted] = await db.$client.batch([
		prep(
			db,
			`INSERT INTO events (id, project_id, title, description, location, all_day, start_on, end_on, start_at, end_at,
				first_on, last_on, visibility, rec_freq, rec_interval, rec_until_on, created_by, created_at, updated_at, deleted_at)
			 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18, NULL
			 WHERE (SELECT count(*) FROM events WHERE created_by = ?17 AND deleted_at IS NULL) < ${CAL_LIMITS.eventsLivePerUser}
			   AND (SELECT count(*) FROM events WHERE created_by = ?17 AND created_at > ?18 - ${DAY_MS}) < ${CAL_LIMITS.eventsPerUserPerDay}
			   AND ${refsSql('?2', '?19')}`,
			id,
			input.projectId,
			input.title,
			input.description,
			input.location,
			input.allDay ? 1 : 0,
			input.startOn,
			input.endOn,
			input.startAt,
			input.endAt,
			input.firstOn,
			input.lastOn,
			input.visibility,
			input.recFreq,
			input.recInterval,
			input.recUntilOn,
			actor.id,
			at,
			attendees
		),
		prep(
			db,
			`INSERT INTO event_attendees (event_id, user_id, created_at)
			 SELECT ?1, u.id, ?2 FROM users u
			 WHERE u.id IN (SELECT value FROM json_each(?3)) AND u.status = 'active'
			   AND EXISTS (SELECT 1 FROM events WHERE id = ?1)`,
			id,
			at,
			attendees
		)
	]);
	if ((inserted?.meta.changes ?? 0) === 1) return { ok: true, id };
	const counts = await prep(
		db,
		`SELECT (SELECT count(*) FROM events WHERE created_by = ?1 AND deleted_at IS NULL) AS live,
			(SELECT count(*) FROM events WHERE created_by = ?1 AND created_at > ?2 - ${DAY_MS}) AS mine`,
		actor.id,
		at
	).first<{ live: number; mine: number }>();
	if ((counts?.live ?? 0) >= CAL_LIMITS.eventsLivePerUser)
		return { ok: false, reason: 'live_limit' };
	if ((counts?.mine ?? 0) >= CAL_LIMITS.eventsPerUserPerDay)
		return { ok: false, reason: 'daily_limit' };
	const refs = await checkEventRefs(db, { ...input, attendeeIds: JSON.parse(attendees) });
	return { ok: false, reason: refs.projectId ? 'project' : 'attendees' };
}

/** Why a guarded change of a visible event wrote nothing. */
async function refusal(
	db: Db,
	actor: Actor,
	id: string,
	expected: number | null,
	input?: EventInput
): Promise<EventWrite> {
	const current = await getVisibleEvent(db, actor.id, id);
	if (!current) return { ok: false, reason: 'not_found' };
	if (!canManageEvent(actor, current)) return { ok: false, reason: 'forbidden' };
	if (expected !== null && current.updatedAt !== expected) return { ok: false, reason: 'conflict' };
	if (input) {
		const refs = await checkEventRefs(db, {
			...input,
			attendeeIds: JSON.parse(attendeesOf(input, current.createdBy))
		});
		if (refs.projectId) return { ok: false, reason: 'project' };
		if (refs.attendees) return { ok: false, reason: 'attendees' };
	}
	return { ok: false, reason: 'conflict' };
}

/**
 * Saves a whole event (and series) against version `expected`. One batch: the guarded UPDATE (live, visible, the
 * actor may manage it, unchanged since `expected`, project and attendees valid), then the attendee replacement and
 * the reminder reschedule, each applied only if the UPDATE stored version `:new`. Pending reminders of the event get
 * `fire_at = now`: the next jobs run (within a minute) re-derives each one from the edited event, so an edit can delay
 * a reminder by a minute but never make it fire at a stale time.
 */
export async function updateEvent(
	db: Db,
	actor: Actor,
	id: string,
	input: EventInput,
	expected: number,
	at: number
): Promise<EventWrite> {
	const updatedAt = Math.max(at, expected + 1);
	const current = await getVisibleEvent(db, actor.id, id);
	if (!current) return { ok: false, reason: 'not_found' };
	const attendees = attendeesOf(input, current.createdBy);
	const won = `EXISTS (SELECT 1 FROM events w WHERE w.id = ?1 AND w.updated_at = ?2)`;
	const [updated] = await db.$client.batch([
		prep(
			db,
			`UPDATE events SET project_id = ?5, title = ?6, description = ?7, location = ?8, all_day = ?9, start_on = ?10,
				end_on = ?11, start_at = ?12, end_at = ?13, first_on = ?14, last_on = ?15, visibility = ?16, rec_freq = ?17,
				rec_interval = ?18, rec_until_on = ?19, updated_at = ?2
			 WHERE id = ?1 AND updated_at = ?3 AND ${eventLiveSql('events')} AND ${eventVisibleSql('events', '?4')}
			   AND ${manageSql('events', '?4', '?20')} AND ${refsSql('?5', '?21')}`,
			id,
			updatedAt,
			expected,
			actor.id,
			input.projectId,
			input.title,
			input.description,
			input.location,
			input.allDay ? 1 : 0,
			input.startOn,
			input.endOn,
			input.startAt,
			input.endAt,
			input.firstOn,
			input.lastOn,
			input.visibility,
			input.recFreq,
			input.recInterval,
			input.recUntilOn,
			actor.role === 'admin' ? 1 : 0,
			attendees
		),
		prep(
			db,
			`DELETE FROM event_attendees WHERE event_id = ?1 AND user_id NOT IN (SELECT value FROM json_each(?3)) AND ${won}`,
			id,
			updatedAt,
			attendees
		),
		prep(
			db,
			`INSERT OR IGNORE INTO event_attendees (event_id, user_id, created_at)
			 SELECT ?1, u.id, ?4 FROM users u WHERE u.id IN (SELECT value FROM json_each(?3)) AND u.status = 'active' AND ${won}`,
			id,
			updatedAt,
			attendees,
			at
		),
		prep(
			db,
			`UPDATE reminders SET fire_at = ?3, claim_token = NULL, claim_until = NULL, retry_at = NULL, attempts = 0,
				updated_at = ?3
			 WHERE target_kind = 'event' AND target_id = ?1 AND done_at IS NULL AND deleted_at IS NULL AND ${won}`,
			id,
			updatedAt,
			at
		)
	]);
	if ((updated?.meta.changes ?? 0) === 1) return { ok: true };
	return refusal(db, actor, id, expected, input);
}

/** Soft-deletes a whole event or series (creator or admin; idempotent). No restore UI this pass. */
export async function deleteEvent(
	db: Db,
	actor: Actor,
	id: string,
	at: number
): Promise<EventWrite> {
	const { meta } = await prep(
		db,
		`UPDATE events SET deleted_at = ?3, updated_at = max(?3, updated_at + 1)
		 WHERE id = ?1 AND ${eventLiveSql('events')} AND ${eventVisibleSql('events', '?2')} AND ${manageSql('events', '?2', '?4')}`,
		id,
		actor.id,
		at,
		actor.role === 'admin' ? 1 : 0
	).run();
	if ((meta.changes ?? 0) === 1) return { ok: true };
	return refusal(db, actor, id, null);
}

/** Removes the occurrence of a series that starts on `onDate` (an `event_exceptions` row; idempotent). */
export async function deleteOccurrence(
	db: Db,
	actor: Actor,
	id: string,
	onDate: string,
	at: number
): Promise<EventWrite> {
	const { meta } = await prep(
		db,
		`INSERT OR IGNORE INTO event_exceptions (event_id, on_date, created_by, created_at)
		 SELECT e.id, ?3, ?2, ?4 FROM events e
		 WHERE e.id = ?1 AND e.rec_freq IS NOT NULL AND ${eventLiveSql('e')} AND ${eventVisibleSql('e', '?2')}
		   AND ${manageSql('e', '?2', '?5')}`,
		id,
		actor.id,
		onDate,
		at,
		actor.role === 'admin' ? 1 : 0
	).run();
	if ((meta.changes ?? 0) === 1) return { ok: true };
	const current = await getVisibleEvent(db, actor.id, id);
	if (!current) return { ok: false, reason: 'not_found' };
	if (!canManageEvent(actor, current)) return { ok: false, reason: 'forbidden' };
	return { ok: true };
}

/** Whether the occurrence of event `id` on `onDate` was removed. */
export async function isOccurrenceRemoved(db: Db, id: string, onDate: string): Promise<boolean> {
	const row = await prep(
		db,
		`SELECT 1 AS x FROM event_exceptions WHERE event_id = ?1 AND on_date = ?2`,
		id,
		onDate
	).first();
	return row !== null;
}

export interface WindowEvent extends TimingRow {
	id: string;
	title: string;
	visibility: EventVisibility;
}

/**
 * The live events `viewerId` sees that touch `from`..`to` (one indexed range predicate on first_on/last_on), at most
 * `max` (the caller passes the cap + 1 to learn that it was hit), plus the removed occurrences of those events near the
 * window. Two queries whatever the count.
 */
export async function eventsInWindow(
	db: Db,
	viewerId: string,
	from: string,
	to: string,
	options: { projectId: string | null; mine: boolean; max: number }
): Promise<{ rows: WindowEvent[]; exceptions: Map<string, Set<string>> }> {
	const { results } = await prep(
		db,
		`SELECT e.id, e.title, e.visibility, ${timingColumns('e')} FROM events e
		 WHERE e.first_on <= ?2 AND e.last_on >= ?1 AND ${eventLiveSql('e')} AND ${eventVisibleSql('e', '?3')}
		   AND (?4 IS NULL OR e.project_id = ?4)
		   AND (?5 = 0 OR e.created_by = ?3 OR EXISTS (SELECT 1 FROM event_attendees m WHERE m.event_id = e.id AND m.user_id = ?3))
		 ORDER BY e.first_on, e.id LIMIT ?6`,
		from,
		to,
		viewerId,
		options.projectId,
		options.mine ? 1 : 0,
		options.max
	).all<WindowEvent>();
	const exceptions = new Map<string, Set<string>>();
	const recurring = results.filter((r) => r.recFreq !== null).map((r) => r.id);
	if (recurring.length > 0) {
		const x = await prep(
			db,
			`SELECT event_id AS eventId, on_date AS onDate FROM event_exceptions
			 WHERE event_id IN (SELECT value FROM json_each(?1)) AND on_date BETWEEN ?2 AND ?3 LIMIT 5000`,
			JSON.stringify(recurring),
			addDays(from, -CAL_LIMITS.allDaySpanMaxDays - 14),
			to
		).all<{ eventId: string; onDate: string }>();
		for (const row of x.results) {
			const set = exceptions.get(row.eventId) ?? new Set<string>();
			set.add(row.onDate);
			exceptions.set(row.eventId, set);
		}
	}
	return { rows: results, exceptions };
}
