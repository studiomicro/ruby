import {
	DAY_MS,
	findOccurrence,
	MINUTE_MS,
	REMINDER_LIMITS,
	TASK_ANCHOR_TIME,
	zonedToUtc
} from '#lib/shared/calendar';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { ReminderMode, ReminderOutcome, ReminderTargetKind } from '#lib/shared/enums';
import type { Db } from '../db';
import { reminders } from '../db/schema';
import {
	eventLiveSql,
	eventVisibleSql,
	timingColumns,
	toTiming,
	type TimingRow
} from '../events/timing';
import { liveTargetSql } from '../targets/resolve';
import { formatTaskRef, taskPath } from '../tasks/format';
import { newId } from '../util';

/**
 * Reminders as their owner manages them (RB-09 PRD › Reminders): create, list, delete. A reminder is private to its
 * owner: every query carries `user_id = :actor`, so another user's reminder (admin included) behaves like a missing
 * one. Creation re-checks the target, the caps and the dedupe key inside one guarded INSERT.
 */

const prep = (db: Db, query: string, ...params: unknown[]) =>
	db.$client.prepare(query).bind(...params);

export type ReminderRequest =
	| { kind: 'task'; taskId: string; mode: 'relative'; offset: number }
	| { kind: 'task'; taskId: string; mode: 'absolute'; remindAt: number }
	| { kind: 'event'; eventId: string; offset: number }
	| { kind: 'personal'; title: string; remindAt: number };

export type ReminderCreate =
	| { ok: true; id: string; duplicate: boolean }
	| {
			ok: false;
			reason:
				| 'not_found'
				| 'no_due_date'
				| 'past'
				| 'too_far'
				| 'target_limit'
				| 'user_limit'
				| 'daily_limit';
	  };

export const REMINDER_MESSAGES = {
	not_found: 'That item is not available.',
	no_due_date: 'Set a due date first.',
	past: 'That time has already passed.',
	too_far: 'Choose a time at most two years ahead.',
	target_limit: `You can have up to ${REMINDER_LIMITS.perTarget} reminders here.`,
	user_limit: `You can have up to ${REMINDER_LIMITS.pendingPerUser} pending reminders.`,
	daily_limit: `You can create at most ${REMINDER_LIMITS.createsPerUserPerDay} reminders a day. Try again tomorrow.`,
	offset: 'Choose one of the listed times.',
	when: 'Enter a date and a time.',
	title: 'Enter what to remind you of.',
	titleLong: `Use at most ${REMINDER_LIMITS.titleMax} characters.`,
	notFound: 'Reminder not found.'
} as const;

/** The first fire time of an event reminder `offset` minutes before an occurrence, at least a minute ahead of `at`. */
async function eventFireAt(
	db: Db,
	userId: string,
	eventId: string,
	offset: number,
	at: number,
	zone: string
): Promise<number | 'not_found' | 'past'> {
	const [ev, ex] = await db.$client.batch([
		prep(
			db,
			`SELECT ${timingColumns('e')} FROM events e WHERE e.id = ?1 AND ${eventLiveSql('e')} AND ${eventVisibleSql('e', '?2')}`,
			eventId,
			userId
		),
		prep(
			db,
			`SELECT on_date AS onDate FROM event_exceptions WHERE event_id = ?1 LIMIT 5000`,
			eventId
		)
	]);
	const row = ev?.results[0] as TimingRow | undefined;
	if (!row) return 'not_found';
	const exceptions = new Set(((ex?.results ?? []) as { onDate: string }[]).map((r) => r.onDate));
	const off = offset * MINUTE_MS;
	// The same rule the jobs Worker re-derives with (dispatch.ts › plan): first occurrence a minute after creation.
	const occ = findOccurrence(
		toTiming(row),
		exceptions,
		zone,
		(o) => o.startAt - off >= at + REMINDER_LIMITS.minLeadMs
	);
	return occ ? occ.startAt - off : 'past';
}

/** SQL: the reminder target bound as `?3`/`?4` (kind/id) is live and visible to the owner `?2`. */
const targetVisibleSql = `(
	(?3 = 'personal')
	OR (?3 = 'task' AND ${liveTargetSql('task', '?4')})
	OR (?3 = 'event' AND EXISTS (SELECT 1 FROM events e WHERE e.id = ?4 AND ${eventLiveSql('e')} AND ${eventVisibleSql('e', '?2')})))`;

/**
 * Creates one reminder of `userId`. The fire time is computed here from the live target in TEAM_TIME_ZONE (`zone`);
 * the INSERT then holds the caps (10 per target, 200 pending per user), the target's visibility and the dedupe key
 * (`ON CONFLICT DO NOTHING`): an identical second create returns the existing reminder.
 */
export async function createReminder(
	db: Db,
	userId: string,
	req: ReminderRequest,
	at: number,
	zone: string
): Promise<ReminderCreate> {
	let fireAt: number;
	let mode: ReminderMode;
	let offset: number | null = null;
	let remindAt: number | null = null;
	let title = '';
	const kind: ReminderTargetKind = req.kind;
	const targetId = req.kind === 'task' ? req.taskId : req.kind === 'event' ? req.eventId : null;

	if (req.kind === 'event') {
		mode = 'relative';
		offset = req.offset;
		const fire = await eventFireAt(db, userId, req.eventId, req.offset, at, zone);
		if (fire === 'not_found' || fire === 'past') return { ok: false, reason: fire };
		fireAt = fire;
	} else if (req.kind === 'task' && req.mode === 'relative') {
		mode = 'relative';
		offset = req.offset;
		const task = await prep(
			db,
			`SELECT t.due_on AS dueOn FROM tasks t WHERE t.id = ?1 AND ${liveTargetSql('task', '?1')}`,
			req.taskId
		).first<{ dueOn: string | null }>();
		if (!task) return { ok: false, reason: 'not_found' };
		if (!task.dueOn) return { ok: false, reason: 'no_due_date' };
		fireAt = zonedToUtc(task.dueOn, TASK_ANCHOR_TIME, zone) - req.offset * MINUTE_MS;
	} else {
		mode = 'absolute';
		remindAt = req.remindAt;
		fireAt = req.remindAt;
		if (req.kind === 'personal') title = req.title;
		if (fireAt > at + REMINDER_LIMITS.maxAheadMs) return { ok: false, reason: 'too_far' };
	}
	if (fireAt < at + REMINDER_LIMITS.minLeadMs) return { ok: false, reason: 'past' };

	const id = newId();
	const { results } = await prep(
		db,
		`INSERT INTO reminders (id, user_id, target_kind, target_id, mode, offset_min, remind_at, title, fire_at,
			attempts, created_at, updated_at)
		 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10
		 WHERE (SELECT count(*) FROM reminders WHERE user_id = ?2 AND target_kind = ?3 AND ifnull(target_id, '') = ifnull(?4, '')
		        AND target_kind <> 'personal' AND done_at IS NULL AND deleted_at IS NULL) < ${REMINDER_LIMITS.perTarget}
		   AND (SELECT count(*) FROM reminders WHERE user_id = ?2 AND done_at IS NULL AND deleted_at IS NULL) < ${REMINDER_LIMITS.pendingPerUser}
		   AND (SELECT count(*) FROM reminders WHERE user_id = ?2 AND created_at > ?10 - ${DAY_MS}) < ${REMINDER_LIMITS.createsPerUserPerDay}
		   AND ${targetVisibleSql}
		 ON CONFLICT DO NOTHING
		 RETURNING id`,
		id,
		userId,
		kind,
		targetId,
		mode,
		offset,
		remindAt,
		title,
		fireAt,
		at
	).all<{ id: string }>();
	if (results.length === 1) return { ok: true, id, duplicate: false };

	const why = await prep(
		db,
		`SELECT
			(SELECT id FROM reminders WHERE user_id = ?1 AND target_kind = ?2 AND ifnull(target_id, '') = ifnull(?3, '')
			   AND mode = ?4 AND ifnull(offset_min, -1) = ifnull(?5, -1) AND ifnull(remind_at, -1) = ifnull(?6, -1)
			   AND title = ?7 AND done_at IS NULL AND deleted_at IS NULL) AS existing,
			(SELECT count(*) FROM reminders WHERE user_id = ?1 AND target_kind = ?2 AND ifnull(target_id, '') = ifnull(?3, '')
			   AND target_kind <> 'personal' AND done_at IS NULL AND deleted_at IS NULL) AS onTarget,
			(SELECT count(*) FROM reminders WHERE user_id = ?1 AND done_at IS NULL AND deleted_at IS NULL) AS pending,
			(SELECT count(*) FROM reminders WHERE user_id = ?1 AND created_at > ?8 - ${DAY_MS}) AS today`,
		userId,
		kind,
		targetId,
		mode,
		offset,
		remindAt,
		title,
		at
	).first<{ existing: string | null; onTarget: number; pending: number; today: number }>();
	if (why?.existing) return { ok: true, id: why.existing, duplicate: true };
	if ((why?.onTarget ?? 0) >= REMINDER_LIMITS.perTarget)
		return { ok: false, reason: 'target_limit' };
	if ((why?.pending ?? 0) >= REMINDER_LIMITS.pendingPerUser)
		return { ok: false, reason: 'user_limit' };
	if ((why?.today ?? 0) >= REMINDER_LIMITS.createsPerUserPerDay)
		return { ok: false, reason: 'daily_limit' };
	return { ok: false, reason: 'not_found' };
}

/** Soft-deletes one of `userId`'s own reminders. False when it is not theirs, missing or already deleted. */
export async function deleteReminder(
	db: Db,
	userId: string,
	id: string,
	at: number
): Promise<boolean> {
	const { meta } = await prep(
		db,
		`UPDATE reminders SET deleted_at = ?3, updated_at = ?3 WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
		id,
		userId,
		at
	).run();
	return (meta.changes ?? 0) === 1;
}

/**
 * The statement a task edit adds to its batch when the due date changes: the task's pending relative reminders get
 * `fire_at = now`, so the next jobs run re-derives each from the new due date (dispatch.ts › plan) — a reminder
 * whose new time is still ahead is rescheduled, one whose time has passed is canceled, never sent at a stale time.
 * Applied only if the edit stored version `updatedAt`.
 */
export function taskDueChangedStatement(db: Db, taskId: string, updatedAt: number, at: number) {
	return db
		.update(reminders)
		.set({
			fireAt: at,
			claimToken: null,
			claimUntil: null,
			retryAt: null,
			attempts: 0,
			updatedAt: at
		})
		.where(
			and(
				eq(reminders.targetKind, 'task'),
				eq(reminders.targetId, taskId),
				eq(reminders.mode, 'relative'),
				isNull(reminders.doneAt),
				isNull(reminders.deletedAt),
				sql`exists (select 1 from tasks t where t.id = ${taskId} and t.updated_at = ${updatedAt})`
			)
		);
}

export interface ReminderView {
	id: string;
	targetKind: ReminderTargetKind;
	mode: ReminderMode;
	offsetMin: number | null;
	remindAt: number | null;
	title: string;
	fireAt: number;
	doneAt: number | null;
	outcome: ReminderOutcome | null;
	createdAt: number;
	/** What the reminder is about, for the list; null when the task or event is gone or no longer visible. */
	targetTitle: string | null;
	href: string | null;
}

interface ReminderListRow extends Omit<ReminderView, 'targetTitle' | 'href'> {
	targetId: string | null;
}

const LIST_COLUMNS = `r.id, r.target_kind AS targetKind, r.target_id AS targetId, r.mode, r.offset_min AS offsetMin,
	r.remind_at AS remindAt, r.title, r.fire_at AS fireAt, r.done_at AS doneAt, r.outcome, r.created_at AS createdAt`;

/** Titles and links of the rows' targets the owner can still see: one query per kind. */
async function describe(db: Db, userId: string, rows: ReminderListRow[]): Promise<ReminderView[]> {
	const ids = (kind: string) =>
		JSON.stringify([...new Set(rows.filter((r) => r.targetKind === kind).map((r) => r.targetId))]);
	const [tasks, events] = await db.$client.batch([
		prep(
			db,
			`SELECT t.id, t.number, t.title, p.key FROM tasks t JOIN projects p ON p.id = t.project_id
			 WHERE t.id IN (SELECT value FROM json_each(?1)) AND t.deleted_at IS NULL AND p.deleted_at IS NULL`,
			ids('task')
		),
		prep(
			db,
			`SELECT e.id, e.title FROM events e
			 WHERE e.id IN (SELECT value FROM json_each(?1)) AND ${eventLiveSql('e')} AND ${eventVisibleSql('e', '?2')}`,
			ids('event'),
			userId
		)
	]);
	const taskMap = new Map(
		((tasks?.results ?? []) as { id: string; number: number; title: string; key: string }[]).map(
			(t) => [t.id, t]
		)
	);
	const eventMap = new Map(
		((events?.results ?? []) as { id: string; title: string }[]).map((e) => [e.id, e])
	);
	return rows.map(({ targetId, ...r }) => {
		if (r.targetKind === 'task') {
			const t = targetId ? taskMap.get(targetId) : undefined;
			return {
				...r,
				targetTitle: t ? `${formatTaskRef(t.key, t.number)} ${t.title}` : null,
				href: t ? taskPath(t.key, t.number) : null
			};
		}
		if (r.targetKind === 'event') {
			const e = targetId ? eventMap.get(targetId) : undefined;
			return { ...r, targetTitle: e?.title ?? null, href: e ? `/calendar/events/${e.id}` : null };
		}
		return { ...r, targetTitle: r.title, href: null };
	});
}

/** `userId`'s pending reminders (soonest first, at most 200) and the latest 50 closed ones. */
export async function listMyReminders(
	db: Db,
	userId: string
): Promise<{ pending: ReminderView[]; history: ReminderView[] }> {
	const [pending, history] = await db.$client.batch([
		prep(
			db,
			`SELECT ${LIST_COLUMNS} FROM reminders r WHERE r.user_id = ?1 AND r.done_at IS NULL AND r.deleted_at IS NULL
			 ORDER BY r.fire_at, r.id LIMIT ${REMINDER_LIMITS.pendingPerUser}`,
			userId
		),
		prep(
			db,
			`SELECT ${LIST_COLUMNS} FROM reminders r WHERE r.user_id = ?1 AND r.done_at IS NOT NULL AND r.deleted_at IS NULL
			 ORDER BY r.done_at DESC, r.id LIMIT 50`,
			userId
		)
	]);
	const rows = [
		...((pending?.results ?? []) as ReminderListRow[]),
		...((history?.results ?? []) as ReminderListRow[])
	];
	const views = await describe(db, userId, rows);
	return {
		pending: views.filter((v) => v.doneAt === null),
		history: views.filter((v) => v.doneAt !== null)
	};
}

/** `userId`'s reminders on one task or event: pending ones and the latest 5 closed. */
export async function listTargetReminders(
	db: Db,
	userId: string,
	kind: 'task' | 'event',
	targetId: string
): Promise<ReminderView[]> {
	const { results } = await prep(
		db,
		`SELECT * FROM (
			SELECT ${LIST_COLUMNS} FROM reminders r WHERE r.user_id = ?1 AND r.target_kind = ?2 AND r.target_id = ?3
			  AND r.deleted_at IS NULL AND r.done_at IS NULL ORDER BY r.fire_at LIMIT ${REMINDER_LIMITS.perTarget})
		 UNION ALL SELECT * FROM (
			SELECT ${LIST_COLUMNS} FROM reminders r WHERE r.user_id = ?1 AND r.target_kind = ?2 AND r.target_id = ?3
			  AND r.deleted_at IS NULL AND r.done_at IS NOT NULL ORDER BY r.done_at DESC LIMIT 5)`,
		userId,
		kind,
		targetId
	).all<ReminderListRow>();
	return results.map((r) => ({ ...r, targetTitle: null, href: null }));
}

/** The jobs Worker's last run (UTC ms), or null when it never ran. */
export async function jobsLastRun(db: Db): Promise<number | null> {
	const row = await prep(db, `SELECT value FROM app_meta WHERE key = 'jobs_last_run'`).first<{
		value: string;
	}>();
	const n = Number(row?.value);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}
