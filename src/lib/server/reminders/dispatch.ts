import {
	findOccurrence,
	MINUTE_MS,
	REMINDER_LIMITS,
	TASK_ANCHOR_TIME,
	zonedToUtc,
	type EventTiming,
	type Occurrence
} from '../../shared/calendar';
import { CLOSED_TASK_STATUSES, type ReminderOutcome, type TaskStatus } from '../../shared/enums';
import { eventLiveSql, timingColumns, toTiming, type TimingRow } from '../events/timing';
import { errorLabel, newId } from '../util';
import { eventSummary, personalSummary, taskSummary } from './summary';

/**
 * The reminder scheduler (RB-09 PRD › Scheduler), run by the `ruby-jobs` Worker once a minute and called directly by
 * the tests with an injected clock. Raw D1 only and no app-only imports, so both Workers bundle the same code.
 *
 * Each round claims up to ROUND_SIZE due reminders in ONE guarded UPDATE (a fresh claim token per round, a 5-minute
 * lease), so overlapping runs never hold the same row; every write after it is guarded by that token. Per reminder
 * the fire time is re-derived from the live target (the stored `fire_at` is a cache): a changed target reschedules
 * instead of sending, a gone or closed target cancels, more than 24 h late is `missed`, otherwise one batch inserts the
 * notification (unique on reminder and occurrence, so a duplicate is impossible) and closes the reminder — or, for a
 * recurring event, moves it to the next occurrence. One failing reminder backs off and never blocks the rest.
 */

export const ROUND_SIZE = 50;
export const MAX_ROUNDS = 3;
/** A run stops starting rounds after this long (by the injected clock). */
export const RUN_BUDGET_MS = 20_000;
export const CLAIM_LEASE_MS = 5 * MINUTE_MS;
/** Attempts after which a failing reminder closes as `dead`. */
export const MAX_ATTEMPTS = 5;

export interface ReminderRow {
	id: string;
	user_id: string;
	target_kind: 'task' | 'event' | 'personal';
	target_id: string | null;
	mode: 'relative' | 'absolute';
	offset_min: number | null;
	remind_at: number | null;
	title: string;
	fire_at: number;
	last_fired_at: number | null;
	claim_token: string | null;
	attempts: number;
	created_at: number;
	email_sent_at: number | null;
}

/** Sends one plain-text e-mail (Cloudflare Email Sending's `send_email` binding, owner answer O5). */
export interface EmailSender {
	from: string;
	/** `https://<app host>` for the links in the mail, or null when the host is not configured (no links). */
	origin: string | null;
	send: (message: { from: string; to: string; subject: string; text: string }) => Promise<unknown>;
}

export interface DispatchOptions {
	zone: string;
	/** Null or absent: e-mail is off and in-app delivery goes on alone. */
	email?: EmailSender | null;
	/** The elapsed-time clock for the run budget (tests inject one); the logical `now` stays fixed for the run. */
	clock?: () => number;
}

export interface DispatchReport {
	rounds: number;
	claimed: number;
	sent: number;
	rescheduled: number;
	missed: number;
	canceled: number;
	failed: number;
	dead: number;
	emailed: number;
}

const CLAIM_SQL = `UPDATE reminders SET claim_token = ?1, claim_until = ?3, attempts = attempts + 1, updated_at = ?2
	WHERE id IN (SELECT id FROM reminders
		WHERE done_at IS NULL AND deleted_at IS NULL AND fire_at <= ?2
		  AND (retry_at IS NULL OR retry_at <= ?2)
		  AND (claim_until IS NULL OR claim_until < ?2)
		ORDER BY fire_at, id LIMIT ?4)
	RETURNING id, user_id, target_kind, target_id, mode, offset_min, remind_at, title, fire_at, last_fired_at,
		claim_token, attempts, created_at, email_sent_at`;

interface OwnerRow {
	id: string;
	status: string;
	email: string;
	emailReminders: number | null;
}
interface TaskRow {
	id: string;
	number: number;
	title: string;
	status: TaskStatus;
	dueOn: string | null;
	key: string;
}
interface EventRow extends TimingRow {
	id: string;
	title: string;
	visibility: 'team' | 'private';
	createdBy: string;
}

interface Targets {
	owners: Map<string, OwnerRow>;
	tasks: Map<string, TaskRow>;
	events: Map<string, EventRow & { timing: EventTiming }>;
	/** `<event id>:<user id>` of the claimed owners who attend. */
	attends: Set<string>;
	exceptions: Map<string, Set<string>>;
}

const idsJson = (ids: (string | null)[]) =>
	JSON.stringify([...new Set(ids.filter((id): id is string => !!id))]);

/** The owners and live targets of one claimed round: one D1 round trip whatever the round's size. */
async function loadTargets(db: D1Database, rows: readonly ReminderRow[]): Promise<Targets> {
	const owners = idsJson(rows.map((r) => r.user_id));
	const taskIds = idsJson(rows.filter((r) => r.target_kind === 'task').map((r) => r.target_id));
	const eventIds = idsJson(rows.filter((r) => r.target_kind === 'event').map((r) => r.target_id));
	const [u, t, e, a, x] = await db.batch([
		db
			.prepare(
				`SELECT u.id, u.status, u.email, p.email_reminders AS emailReminders FROM users u
				 LEFT JOIN user_calendar_prefs p ON p.user_id = u.id
				 WHERE u.id IN (SELECT value FROM json_each(?1))`
			)
			.bind(owners),
		// Live tasks of live projects only; a deleted one simply is not found.
		db
			.prepare(
				`SELECT t.id, t.number, t.title, t.status, t.due_on AS dueOn, p.key FROM tasks t
				 JOIN projects p ON p.id = t.project_id
				 WHERE t.id IN (SELECT value FROM json_each(?1)) AND t.deleted_at IS NULL AND p.deleted_at IS NULL`
			)
			.bind(taskIds),
		db
			.prepare(
				`SELECT e.id, e.title, e.visibility, e.created_by AS createdBy, ${timingColumns('e')} FROM events e
				 WHERE e.id IN (SELECT value FROM json_each(?1)) AND ${eventLiveSql('e')}`
			)
			.bind(eventIds),
		db
			.prepare(
				`SELECT event_id AS eventId, user_id AS userId FROM event_attendees
				 WHERE event_id IN (SELECT value FROM json_each(?1)) AND user_id IN (SELECT value FROM json_each(?2))`
			)
			.bind(eventIds, owners),
		db
			.prepare(
				`SELECT event_id AS eventId, on_date AS onDate FROM event_exceptions
				 WHERE event_id IN (SELECT value FROM json_each(?1)) LIMIT 5000`
			)
			.bind(eventIds)
	]);
	const exceptions = new Map<string, Set<string>>();
	for (const row of (x?.results ?? []) as { eventId: string; onDate: string }[]) {
		const set = exceptions.get(row.eventId) ?? new Set<string>();
		set.add(row.onDate);
		exceptions.set(row.eventId, set);
	}
	return {
		owners: new Map(((u?.results ?? []) as OwnerRow[]).map((o) => [o.id, o])),
		tasks: new Map(((t?.results ?? []) as TaskRow[]).map((r) => [r.id, r])),
		events: new Map(
			((e?.results ?? []) as EventRow[]).map((r) => [r.id, { ...r, timing: toTiming(r) }])
		),
		attends: new Set(
			((a?.results ?? []) as { eventId: string; userId: string }[]).map(
				(r) => `${r.eventId}:${r.userId}`
			)
		),
		exceptions
	};
}

/** What one claimed reminder comes to. */
type Plan =
	| { do: 'close'; outcome: Exclude<ReminderOutcome, 'dead'> }
	| { do: 'reschedule'; fireAt: number; cursor?: number }
	| { do: 'missed'; occurrenceAt: number; next: number | null }
	| {
			do: 'send';
			occurrenceAt: number;
			summary: string;
			/** Recurring: the next fire time, or null when this was the last occurrence. */
			next: number | null;
	  };

/**
 * The plan for reminder `r` at `now`. `want` is the fire time derived from the live target. An event moved into the
 * past is not sent late: a one-off event reminder is canceled, a recurring one skips to the first occurrence still
 * ahead. A task or personal reminder whose derived time has passed is sent while at most 24 h late.
 */
function plan(r: ReminderRow, t: Targets, now: number, zone: string): Plan {
	const owner = t.owners.get(r.user_id);
	if (!owner || owner.status !== 'active') return { do: 'close', outcome: 'canceled' };
	const late = (want: number) => now - want > REMINDER_LIMITS.lateMaxMs;

	if (r.target_kind === 'event') {
		const ev = r.target_id ? t.events.get(r.target_id) : undefined;
		if (!ev) return { do: 'close', outcome: 'canceled' };
		if (
			ev.visibility === 'private' &&
			ev.createdBy !== r.user_id &&
			!t.attends.has(`${ev.id}:${r.user_id}`)
		)
			return { do: 'close', outcome: 'canceled' };
		const off = (r.offset_min ?? 0) * MINUTE_MS;
		const exceptions = t.exceptions.get(ev.id) ?? new Set<string>();
		const after = (o: Occurrence, start: number) => o.startAt > start;
		const occ = findOccurrence(ev.timing, exceptions, zone, (o) =>
			r.last_fired_at !== null
				? after(o, r.last_fired_at)
				: o.startAt - off >= r.created_at + REMINDER_LIMITS.minLeadMs
		);
		const ended = (): Plan => ({
			do: 'close',
			outcome: r.last_fired_at !== null ? 'sent' : 'canceled'
		});
		if (!occ) return ended();
		const nextAfter = (o: Occurrence) =>
			findOccurrence(ev.timing, exceptions, zone, (n) => after(n, o.startAt));
		const want = occ.startAt - off;
		if (want !== r.fire_at) {
			if (want > now) return { do: 'reschedule', fireAt: want };
			const ahead = findOccurrence(
				ev.timing,
				exceptions,
				zone,
				(n) => n.startAt > occ.startAt && n.startAt - off > now
			);
			// The cursor sits just before `ahead`, so the next derivation lands on it.
			return ahead
				? { do: 'reschedule', fireAt: ahead.startAt - off, cursor: ahead.startAt - 1 }
				: ended();
		}
		const next = nextAfter(occ);
		const nextFire = next ? next.startAt - off : null;
		if (late(want)) return { do: 'missed', occurrenceAt: occ.startAt, next: nextFire };
		return {
			do: 'send',
			occurrenceAt: occ.startAt,
			summary: eventSummary({ title: ev.title, allDay: ev.timing.allDay }, occ, now, zone),
			next: nextFire
		};
	}

	let want: number;
	let summary: string;
	if (r.target_kind === 'task') {
		const task = r.target_id ? t.tasks.get(r.target_id) : undefined;
		if (!task || CLOSED_TASK_STATUSES.has(task.status)) return { do: 'close', outcome: 'canceled' };
		if (r.mode === 'relative') {
			if (!task.dueOn) return { do: 'close', outcome: 'canceled' };
			want = zonedToUtc(task.dueOn, TASK_ANCHOR_TIME, zone) - (r.offset_min ?? 0) * MINUTE_MS;
		} else want = r.remind_at ?? r.fire_at;
		summary = taskSummary(
			{ ref: `${task.key}-${task.number}`, title: task.title, dueOn: task.dueOn },
			now,
			zone
		);
	} else {
		want = r.remind_at ?? r.fire_at;
		summary = personalSummary(r.title);
	}
	// A stored time that differs from the derived one is a cache gone stale (a due-date edit sets `fire_at = now`).
	// Still ahead: reschedule. Already past (QA F2): treated like any due reminder — sent while at most 24 h late, else
	// closed without a notification.
	if (want !== r.fire_at && want > now) return { do: 'reschedule', fireAt: want };
	if (late(want))
		return want !== r.fire_at
			? { do: 'close', outcome: 'canceled' }
			: { do: 'missed', occurrenceAt: want, next: null };
	return { do: 'send', occurrenceAt: want, summary, next: null };
}

/** A short, content-free code for `last_error` and the log (never the message, never user data). */
const errorCode = (e: unknown) => errorLabel(e).slice(0, 60);

async function apply(
	db: D1Database,
	r: ReminderRow,
	tok: string,
	now: number,
	p: Plan,
	t: Targets,
	opts: DispatchOptions,
	report: DispatchReport
): Promise<void> {
	const guard = `WHERE id = ?1 AND claim_token = ?2 AND done_at IS NULL`;
	const close = (outcome: string, lastFired: number | null) =>
		db
			.prepare(
				`UPDATE reminders SET done_at = ?3, outcome = ?4, last_fired_at = coalesce(?5, last_fired_at),
					claim_token = NULL, claim_until = NULL, retry_at = NULL, last_error = NULL, updated_at = ?3
				 ${guard} AND deleted_at IS NULL`
			)
			.bind(r.id, tok, now, outcome, lastFired);
	const move = (fireAt: number, lastFired: number | null) =>
		db
			.prepare(
				`UPDATE reminders SET fire_at = ?3, last_fired_at = coalesce(?4, last_fired_at), attempts = 0,
					claim_token = NULL, claim_until = NULL, retry_at = NULL, last_error = NULL, updated_at = ?5
				 ${guard}`
			)
			.bind(r.id, tok, fireAt, lastFired, now);

	switch (p.do) {
		case 'close':
			await close(p.outcome, null).run();
			// `sent` here is a series whose last occurrence was already delivered: nothing new is counted.
			if (p.outcome !== 'sent') report[p.outcome] += 1;
			return;
		case 'reschedule':
			await move(p.fireAt, p.cursor ?? null).run();
			report.rescheduled += 1;
			return;
		case 'missed':
			await (
				p.next === null ? close('missed', p.occurrenceAt) : move(p.next, p.occurrenceAt)
			).run();
			report.missed += 1;
			return;
		case 'send': {
			const [inserted] = await db.batch([
				db
					.prepare(
						`INSERT INTO notifications (id, user_id, kind, actor_id, target_kind, target_id, comment_id, summary,
							reminder_id, occurrence_at, created_at, read_at)
						 SELECT ?1, r.user_id, 'reminder', r.user_id, r.target_kind, coalesce(r.target_id, r.id), NULL, ?2,
							r.id, ?3, ?4, NULL
						 FROM reminders r
						 WHERE r.id = ?5 AND r.claim_token = ?6 AND r.done_at IS NULL AND r.deleted_at IS NULL
						 ON CONFLICT DO NOTHING`
					)
					.bind(newId(), p.summary, p.occurrenceAt, now, r.id, tok),
				p.next === null ? close('sent', p.occurrenceAt) : move(p.next, p.occurrenceAt)
			]);
			if ((inserted?.meta.changes ?? 0) === 0) return;
			report.sent += 1;
			await maybeEmail(db, r, p, t, opts, report);
		}
	}
}

/**
 * One e-mail per delivered reminder occurrence when e-mail is configured and the owner opted in. `email_sent_at` is
 * claimed first with a guarded UPDATE (set to the occurrence's fire time), so a retry never mails twice; a failed send
 * is logged by code only and never blocks or repeats the in-app notification.
 */
async function maybeEmail(
	db: D1Database,
	r: ReminderRow,
	p: Extract<Plan, { do: 'send' }>,
	t: Targets,
	opts: DispatchOptions,
	report: DispatchReport
): Promise<void> {
	const owner = t.owners.get(r.user_id);
	if (!opts.email || !owner || owner.emailReminders !== 1) return;
	const claimed = await db
		.prepare(
			`UPDATE reminders SET email_sent_at = ?2 WHERE id = ?1 AND (email_sent_at IS NULL OR email_sent_at < ?2)
			 RETURNING id`
		)
		.bind(r.id, r.fire_at)
		.all();
	if (claimed.results.length === 0) return;
	try {
		await opts.email.send({
			from: opts.email.from,
			to: owner.email,
			subject: `Reminder: ${p.summary}`,
			text: emailText(p.summary, opts.email.origin)
		});
		report.emailed += 1;
	} catch (e) {
		console.error('reminder_email_failed', r.id, errorCode(e));
	}
}

/** The plain-text body: the summary, a link to the inbox and how to stop these mails (no tokens in any link). */
export function emailText(summary: string, origin: string | null): string {
	const open = origin ? `Open Ruby to see it: ${origin}/notifications` : 'Open Ruby to see it.';
	const stop = origin
		? `Turn them off on your Account page: ${origin}/account`
		: 'Turn them off on your Account page in Ruby.';
	return `${summary}\n\n${open}\n\nYou get these e-mails because e-mail reminders are on. ${stop}\n`;
}

/** A failed reminder: backs off (2^attempts minutes, at most 60), or closes as `dead` at MAX_ATTEMPTS. */
async function fail(
	db: D1Database,
	r: ReminderRow,
	tok: string,
	now: number,
	e: unknown,
	report: DispatchReport
): Promise<void> {
	const code = errorCode(e);
	console.error('reminder_dispatch_failed', r.id, code);
	report.failed += 1;
	try {
		if (r.attempts >= MAX_ATTEMPTS) {
			await db
				.prepare(
					`UPDATE reminders SET done_at = ?3, outcome = 'dead', last_error = ?4, claim_token = NULL,
						claim_until = NULL, updated_at = ?3 WHERE id = ?1 AND claim_token = ?2 AND done_at IS NULL`
				)
				.bind(r.id, tok, now, code)
				.run();
			report.dead += 1;
		} else
			await db
				.prepare(
					`UPDATE reminders SET retry_at = ?3, last_error = ?4, claim_token = NULL, claim_until = NULL,
						updated_at = ?5 WHERE id = ?1 AND claim_token = ?2 AND done_at IS NULL`
				)
				.bind(r.id, tok, now + Math.min(2 ** r.attempts, 60) * MINUTE_MS, code, now)
				.run();
	} catch (again) {
		// The lease expires on its own; the row is retried after CLAIM_LEASE_MS.
		console.error('reminder_dispatch_backoff_failed', r.id, errorCode(again));
	}
}

/** Delivers every reminder due at `now`: at most MAX_ROUNDS rounds of ROUND_SIZE, within RUN_BUDGET_MS. */
export async function dispatchDue(
	db: D1Database,
	now: number,
	opts: DispatchOptions
): Promise<DispatchReport> {
	const clock = opts.clock ?? Date.now;
	const started = clock();
	const report: DispatchReport = {
		rounds: 0,
		claimed: 0,
		sent: 0,
		rescheduled: 0,
		missed: 0,
		canceled: 0,
		failed: 0,
		dead: 0,
		emailed: 0
	};
	for (let round = 0; round < MAX_ROUNDS; round++) {
		if (clock() - started >= RUN_BUDGET_MS) break;
		const tok = newId();
		const { results } = await db
			.prepare(CLAIM_SQL)
			.bind(tok, now, now + CLAIM_LEASE_MS, ROUND_SIZE)
			.all<ReminderRow>();
		if (results.length === 0) break;
		report.rounds += 1;
		report.claimed += results.length;
		let targets: Targets;
		try {
			targets = await loadTargets(db, results);
		} catch (e) {
			for (const r of results) await fail(db, r, tok, now, e, report);
			continue;
		}
		for (const r of results) {
			try {
				await apply(db, r, tok, now, plan(r, targets, now, opts.zone), targets, opts, report);
			} catch (e) {
				await fail(db, r, tok, now, e, report);
			}
		}
		if (results.length < ROUND_SIZE) break;
	}
	return report;
}
