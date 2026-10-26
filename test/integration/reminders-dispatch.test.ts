import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { deleteOccurrence, updateEvent } from '#lib/server/events/repo';
import {
	describeNotifications,
	listNotifications,
	unreadCount
} from '#lib/server/notifications/repo';
import { dispatchDue, MAX_ATTEMPTS, type EmailSender } from '#lib/server/reminders/dispatch';
import { emailSender, purgeClosed, runJobs } from '#lib/server/reminders/jobs';
import { createReminder, jobsLastRun, type ReminderRequest } from '#lib/server/reminders/repo';
import { bulkUpdate } from '#lib/server/pm/bulk';
import { deleteTask, patchTask } from '#lib/server/tasks/repo';
import { DAY_MS, MINUTE_MS } from '#lib/shared/calendar';
import { openLocalD1 } from '../helpers/d1';
import {
	at,
	clearCalendar,
	eventInput,
	JKT,
	reminderNotifications,
	reminderRow,
	seedEvent
} from '../helpers/seed-calendar';
import { seedProject, seedTask, taskRow } from '../helpers/seed-tasks';
import { insertUser } from '../helpers/users';

/**
 * RB-09 scheduler against local D1 with an injected clock (PRD › Scheduler, acceptance 19–27): `dispatchDue(db, now)`
 * is what the `ruby-jobs` cron runs every minute.
 */

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
let owner: SessionUser;

const T0 = at('2026-11-02', '08:00');
const run = (
	now: number,
	d: D1Database = d1,
	email: EmailSender | null = null,
	clock?: () => number
) => dispatchDue(d, now, { zone: JKT, email, clock });

async function remind(req: ReminderRequest, user: SessionUser = owner, createdAt = T0) {
	const r = await createReminder(db, user.id, req, createdAt, JKT);
	if (!r.ok) throw new Error(`createReminder failed: ${r.reason}`);
	return r.id;
}
const personal = (title: string, remindAt: number) =>
	({ kind: 'personal', title, remindAt }) as const;

beforeAll(async () => {
	const opened = await openLocalD1();
	d1 = opened.db;
	db = getDb(opened.db);
	dispose = opened.dispose;
});
afterAll(() => dispose());
beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	await clearCalendar(db);
	owner = await insertUser(db, { name: 'Rina Owner' });
});

describe('delivery', () => {
	it('a due reminder becomes exactly one notification, closes sent, never early (19, 20, 26)', async () => {
		const fire = T0 + 60 * MINUTE_MS;
		const id = await remind(personal('Call the supplier', fire));
		expect((await run(fire - 1)).claimed).toBe(0);
		expect(await reminderNotifications(db)).toHaveLength(0);

		const report = await run(fire);
		expect(report).toMatchObject({ claimed: 1, sent: 1 });
		const [n] = await reminderNotifications(db, owner.id);
		expect(n).toMatchObject({
			user_id: owner.id,
			actor_id: owner.id,
			kind: 'reminder',
			target_kind: 'personal',
			summary: 'Call the supplier',
			reminder_id: id,
			occurrence_at: fire,
			read_at: null
		});
		expect(await reminderRow(db, id)).toMatchObject({ outcome: 'sent', claim_token: null });
		expect(await unreadCount(db, owner.id)).toBe(1);
		const { rows } = await listNotifications(db, owner.id, { filter: 'all', before: null });
		const [view] = await describeNotifications(db, rows);
		expect(view).toMatchObject({
			kind: 'reminder',
			summary: 'Call the supplier',
			href: '/reminders'
		});

		// Twice, and later: still one.
		await run(fire);
		await run(fire + DAY_MS);
		expect(await reminderNotifications(db)).toHaveLength(1);
	});

	it('two overlapping runs deliver once', async () => {
		const fire = T0 + 5 * MINUTE_MS;
		for (let i = 0; i < 30; i++) await remind(personal(`Item ${i}`, fire + i));
		const [a, b] = await Promise.all([run(fire + 100), run(fire + 100)]);
		expect(a.sent + b.sent).toBe(30);
		expect(await reminderNotifications(db)).toHaveLength(30);
	});

	it('a clock stepping back cannot double-send; the unique key holds (23)', async () => {
		const fire = T0 + 5 * MINUTE_MS;
		const id = await remind(personal('Once', fire));
		await run(fire);
		await run(fire - 60 * MINUTE_MS);
		await run(fire);
		expect(await reminderNotifications(db)).toHaveLength(1);
		await expect(
			d1
				.prepare(
					`INSERT INTO notifications (id, user_id, kind, actor_id, target_kind, target_id, summary, reminder_id,
						occurrence_at, created_at) VALUES (?1, ?2, 'reminder', ?2, 'personal', ?3, 'x', ?3, ?4, 1)`
				)
				.bind(crypto.randomUUID(), owner.id, id, fire)
				.run()
		).rejects.toThrow(/UNIQUE/);
	});

	it('late: 25 h closes missed without a notification, 23 h is sent (O7)', async () => {
		const a = await remind(personal('Late A', T0 + 5 * MINUTE_MS));
		const b = await remind(personal('Late B', T0 + 5 * MINUTE_MS + 120 * MINUTE_MS));
		// 25 h after A, 23 h after B.
		await run(T0 + 5 * MINUTE_MS + 25 * 60 * MINUTE_MS);
		expect(await reminderRow(db, a)).toMatchObject({ outcome: 'missed' });
		expect(await reminderRow(db, b)).toMatchObject({ outcome: 'sent' });
		expect((await reminderNotifications(db)).map((n) => n.summary)).toEqual(['Late B']);
	});
});

describe('bounds', () => {
	it('50 per round, 3 rounds per run, oldest first; the rest next run (21)', async () => {
		const fire = T0 + 5 * MINUTE_MS;
		const user2 = await insertUser(db);
		for (let i = 0; i < 170; i++)
			await remind(
				personal(`R${String(i).padStart(3, '0')}`, fire + i * 1000),
				i < 100 ? owner : user2
			);
		const first = await run(fire + DAY_MS / 2);
		expect(first).toMatchObject({ rounds: 3, claimed: 150, sent: 150 });
		const left = await d1
			.prepare(`SELECT title FROM reminders WHERE done_at IS NULL ORDER BY fire_at`)
			.all<{ title: string }>();
		expect(left.results.map((r) => r.title)).toEqual(
			Array.from({ length: 20 }, (_, i) => `R${String(150 + i).padStart(3, '0')}`)
		);
		expect(await run(fire + DAY_MS / 2)).toMatchObject({ rounds: 1, claimed: 20, sent: 20 });
	});

	it('the 20 s budget stops starting rounds (injected clock)', async () => {
		const fire = T0 + 5 * MINUTE_MS;
		for (let i = 0; i < 120; i++) await remind(personal(`B${i}`, fire));
		let t = 0;
		const clock = () => (t += 15_000);
		const report = await run(fire, d1, null, clock);
		expect(report.rounds).toBe(1);
		expect(report.claimed).toBe(50);
	});
});

/** A D1 whose batches that insert a notification (a reminder's send) fail while `failing()` says so. */
function failingSends(failing: () => boolean): D1Database {
	type Wrapped = { query: string; real: D1PreparedStatement };
	const wrap = (query: string, real: D1PreparedStatement): D1PreparedStatement =>
		({
			query,
			real,
			bind: (...args: unknown[]) => wrap(query, real.bind(...args)),
			run: () => real.run(),
			all: () => real.all(),
			first: (col?: string) => (col === undefined ? real.first() : real.first(col)),
			raw: () => real.raw()
		}) as unknown as D1PreparedStatement;
	return {
		prepare: (query: string) => wrap(query, d1.prepare(query)),
		batch: async (stmts: D1PreparedStatement[]) => {
			const list = stmts as unknown as Wrapped[];
			if (list.some((s) => s.query.includes('INSERT INTO notifications')) && failing())
				throw new Error('D1_ERROR: forced failure with secret text inside');
			return d1.batch(list.map((s) => s.real));
		}
	} as unknown as D1Database;
}

describe('failures', () => {
	it('one failing reminder backs off, the rest of the batch goes on, the 5th failure is dead (22)', async () => {
		const fire = T0 + 5 * MINUTE_MS;
		const bad = await remind(personal('Bad', fire));
		for (let i = 0; i < 3; i++) await remind(personal(`Good ${i}`, fire + 1 + i));
		let sends = 0;
		// The first send of every run (the oldest: Bad) fails.
		let failNext = true;
		const flaky = failingSends(() => {
			sends += 1;
			const f = failNext;
			failNext = false;
			return f;
		});
		const first = await run(fire + 10, flaky);
		expect(first).toMatchObject({ sent: 3, failed: 1 });
		let row = await reminderRow(db, bad);
		expect(row).toMatchObject({ attempts: 1, claim_token: null, done_at: null });
		expect(row?.retry_at).toBe(fire + 10 + 2 * MINUTE_MS);
		expect(String(row?.last_error)).not.toMatch(/secret|forced/);
		expect(String(row?.last_error).length).toBeLessThanOrEqual(60);

		// Not before retry_at.
		failNext = true;
		expect((await run(fire + 10 + 2 * MINUTE_MS - 1, flaky)).claimed).toBe(0);
		for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
			row = await reminderRow(db, bad);
			failNext = true;
			await run(row?.retry_at as number, flaky);
		}
		row = await reminderRow(db, bad);
		expect(row).toMatchObject({ outcome: 'dead', attempts: MAX_ATTEMPTS });
		expect(await reminderNotifications(db)).toHaveLength(3);
		expect(sends).toBeGreaterThan(0);
	});

	it('the backoff grows 2, 4, 8, 16 minutes', async () => {
		const fire = T0 + 5 * MINUTE_MS;
		const bad = await remind(personal('Always bad', fire));
		const broken = failingSends(() => true);
		let now = fire;
		const gaps: number[] = [];
		for (let i = 0; i < 4; i++) {
			await run(now, broken);
			const next = (await reminderRow(db, bad))?.retry_at as number;
			gaps.push((next - now) / MINUTE_MS);
			now = next;
		}
		expect(gaps).toEqual([2, 4, 8, 16]);
	});

	it('a claim whose lease expired is claimed again', async () => {
		const fire = T0 + 5 * MINUTE_MS;
		const id = await remind(personal('Leased', fire));
		await d1
			.prepare(`UPDATE reminders SET claim_token = 'crashed', claim_until = ?2 WHERE id = ?1`)
			.bind(id, fire + 5 * MINUTE_MS)
			.run();
		expect((await run(fire + MINUTE_MS)).claimed).toBe(0);
		expect((await run(fire + 5 * MINUTE_MS + 1)).sent).toBe(1);
	});
});

describe('live targets (24)', () => {
	it('task reminders: fire time from 09:00 WIB minus the offset; done, canceled-status and deleted tasks cancel', async () => {
		const project = await seedProject(db, owner);
		const t1 = await seedTask(db, owner, project, { dueOn: '2026-11-05', assigneeId: owner.id });
		const t2 = await seedTask(db, owner, project, { dueOn: '2026-11-05' });
		const r1 = await remind({ kind: 'task', taskId: t1.id, mode: 'relative', offset: 1440 });
		const r2 = await remind({ kind: 'task', taskId: t2.id, mode: 'relative', offset: 1440 });
		expect(new Date((await reminderRow(db, r1))?.fire_at as number).toISOString()).toBe(
			'2026-11-04T02:00:00.000Z'
		);
		const row = await taskRow(db, t1.id);
		await patchTask(
			db,
			owner,
			project,
			{ id: t1.id, assigneeId: owner.id },
			'status',
			'done',
			row!.updatedAt,
			T0
		);
		await deleteTask(db, project, t2.id, T0);
		await run(at('2026-11-04', '09:00'));
		expect(await reminderRow(db, r1)).toMatchObject({ outcome: 'canceled' });
		expect(await reminderRow(db, r2)).toMatchObject({ outcome: 'canceled' });
		expect(await reminderNotifications(db)).toHaveLength(0);
	});

	it('a due-date edit moves fire_at in the edit batch; the job reschedules instead of sending', async () => {
		const project = await seedProject(db, owner);
		const t = await seedTask(db, owner, project, { dueOn: '2026-11-05' });
		const r = await remind({ kind: 'task', taskId: t.id, mode: 'relative', offset: 1440 });
		const edit = T0 + MINUTE_MS;
		const before = await taskRow(db, t.id);
		const result = await patchTask(
			db,
			owner,
			project,
			{ id: t.id, assigneeId: null },
			'dueOn',
			'2026-11-10',
			before!.updatedAt,
			edit
		);
		expect(result.ok).toBe(true);
		expect((await reminderRow(db, r))?.fire_at).toBe(edit);
		expect(await run(edit)).toMatchObject({ rescheduled: 1, sent: 0 });
		expect(new Date((await reminderRow(db, r))?.fire_at as number).toISOString()).toBe(
			'2026-11-09T02:00:00.000Z'
		);
		// An edit path that missed the hook: the stale time only reschedules.
		await d1.prepare(`UPDATE tasks SET due_on = '2026-11-20' WHERE id = ?1`).bind(t.id).run();
		expect(await run(at('2026-11-09', '09:00'))).toMatchObject({ rescheduled: 1, sent: 0 });
		const sent = await run(at('2026-11-19', '09:00'));
		expect(sent.sent).toBe(1);
		const [n] = await reminderNotifications(db);
		expect(n?.summary).toMatch(/is due tomorrow$/);
	});

	it('a bulk due-date edit (RB-08) sends the relative reminders back to be re-derived', async () => {
		const project = await seedProject(db, owner);
		const t = await seedTask(db, owner, project, { dueOn: '2026-11-05' });
		const r = await remind({ kind: 'task', taskId: t.id, mode: 'relative', offset: 1440 });
		const edit = T0 + MINUTE_MS;
		const result = await bulkUpdate(db, owner, project.id, [t.id], { dueOn: '2026-11-12' }, edit);
		expect(result.ok).toBe(true);
		expect((await reminderRow(db, r))?.fire_at).toBe(edit);
		expect(await run(edit)).toMatchObject({ rescheduled: 1, sent: 0 });
		expect((await reminderRow(db, r))?.fire_at).toBe(at('2026-11-11', '09:00'));
	});

	it('QA F2: after a due-date edit, a derived time already past is sent within 24 h, closed beyond, canceled without a due date', async () => {
		const project = await seedProject(db, owner);
		const edit = T0 + MINUTE_MS;
		const make = async (dueOn: string) => {
			const t = await seedTask(db, owner, project, { dueOn: '2026-11-05', title: `Due ${dueOn}` });
			const r = await remind({ kind: 'task', taskId: t.id, mode: 'relative', offset: 0 });
			const row = await taskRow(db, t.id);
			const moved = await patchTask(
				db,
				owner,
				project,
				{ id: t.id, assigneeId: null },
				'dueOn',
				dueOn || null,
				row!.updatedAt,
				edit
			);
			expect(moved.ok).toBe(true);
			return r;
		};
		const recent = await make('2026-11-01'); // 09:00 the day before: 23 h ago
		const old = await make('2026-10-30'); // more than 24 h ago
		const cleared = await make('');
		const report = await run(edit);
		expect(report).toMatchObject({ sent: 1, canceled: 2 });
		expect(await reminderRow(db, recent)).toMatchObject({ outcome: 'sent' });
		expect(await reminderRow(db, old)).toMatchObject({ outcome: 'canceled' });
		expect(await reminderRow(db, cleared)).toMatchObject({ outcome: 'canceled' });
		expect((await reminderNotifications(db)).map((n) => n.occurrence_at)).toEqual([
			at('2026-11-01', '09:00')
		]);
	});

	it('QA F2: a reminder due during an outage, then a due-date edit to the same day, is still sent', async () => {
		const project = await seedProject(db, owner);
		const t = await seedTask(db, owner, project, { dueOn: '2026-11-05' });
		const r = await remind({ kind: 'task', taskId: t.id, mode: 'relative', offset: 1440 });
		const fire = at('2026-11-04', '09:00');
		const later = fire + 3 * 60 * MINUTE_MS; // the jobs Worker was down for three hours
		const row = await taskRow(db, t.id);
		await patchTask(
			db,
			owner,
			project,
			{ id: t.id, assigneeId: null },
			'dueOn',
			'2026-11-05',
			row!.updatedAt,
			later
		);
		expect((await reminderRow(db, r))?.fire_at).toBe(later);
		expect(await run(later)).toMatchObject({ sent: 1 });
		expect((await reminderNotifications(db))[0]?.occurrence_at).toBe(fire);
	});

	it('deleted event, deactivated owner, removal from a private event: canceled', async () => {
		const other = await insertUser(db);
		const e1 = await seedEvent(db, owner, {}, T0);
		const e2 = await seedEvent(db, other, { visibility: 'private', attendeeIds: [owner.id] }, T0);
		const e3 = await seedEvent(db, owner, {}, T0);
		const r1 = await remind({ kind: 'event', eventId: e1, offset: 10 });
		const r2 = await remind({ kind: 'event', eventId: e2, offset: 10 });
		const r3 = await remind({ kind: 'event', eventId: e3, offset: 10 }, other);
		await d1.prepare(`UPDATE events SET deleted_at = ?2 WHERE id = ?1`).bind(e1, T0).run();
		await d1.prepare(`DELETE FROM event_attendees WHERE event_id = ?1`).bind(e2).run();
		await d1.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?1`).bind(other.id).run();
		await run(at('2026-11-02', '13:50'));
		for (const r of [r1, r2, r3])
			expect(await reminderRow(db, r)).toMatchObject({ outcome: 'canceled' });
		expect(await reminderNotifications(db)).toHaveLength(0);
	});

	it('an event moved earlier past now is not sent late; moved later is rescheduled', async () => {
		const e = await seedEvent(db, owner, {}, T0);
		const r = await remind({ kind: 'event', eventId: e, offset: 10 });
		const late = await seedEvent(db, owner, { title: 'Later' }, T0);
		const r2 = await remind({ kind: 'event', eventId: late, offset: 10 });
		const now = at('2026-11-02', '13:00');
		const current = await d1
			.prepare(`SELECT id, updated_at AS u FROM events`)
			.all<{ id: string; u: number }>();
		const ver = new Map(current.results.map((x) => [x.id, x.u]));
		const earlier = eventInput({
			startAt: at('2026-11-02', '12:00'),
			endAt: at('2026-11-02', '12:30')
		});
		expect((await updateEvent(db, owner, e, earlier, ver.get(e)!, now)).ok).toBe(true);
		const later = eventInput({
			title: 'Later',
			startAt: at('2026-11-03', '10:00'),
			endAt: at('2026-11-03', '11:00')
		});
		expect((await updateEvent(db, owner, late, later, ver.get(late)!, now)).ok).toBe(true);
		const report = await run(now);
		expect(report).toMatchObject({ sent: 0, canceled: 1, rescheduled: 1 });
		expect(await reminderRow(db, r)).toMatchObject({ outcome: 'canceled' });
		expect((await reminderRow(db, r2))?.fire_at).toBe(at('2026-11-03', '09:50'));
	});
});

describe('recurring events (25)', () => {
	const weekly = () =>
		eventInput({
			title: 'Weekly planning',
			startAt: at('2026-11-02', '10:00'),
			endAt: at('2026-11-02', '11:00'),
			recFreq: 'weekly',
			recUntilOn: '2026-11-16'
		});

	it('fires once per occurrence in order and closes sent after the last', async () => {
		const e = await seedEvent(db, owner, weekly(), T0);
		const r = await remind({ kind: 'event', eventId: e, offset: 10 });
		for (const day of ['2026-11-02', '2026-11-09', '2026-11-16']) {
			const fire = at(day, '09:50');
			expect((await reminderRow(db, r))?.fire_at).toBe(fire);
			expect((await run(fire)).sent).toBe(1);
			await run(fire + MINUTE_MS); // a second run in the same week sends nothing
		}
		const sent = await reminderNotifications(db);
		expect(sent.map((n) => n.occurrence_at)).toEqual([
			at('2026-11-02', '10:00'),
			at('2026-11-09', '10:00'),
			at('2026-11-16', '10:00')
		]);
		expect(sent[0]?.summary).toBe('Weekly planning starts in 10 minutes');
		expect(await reminderRow(db, r)).toMatchObject({ outcome: 'sent' });
	});

	it('skips a deleted occurrence', async () => {
		const e = await seedEvent(db, owner, weekly(), T0);
		const r = await remind({ kind: 'event', eventId: e, offset: 10 });
		await run(at('2026-11-02', '09:50'));
		expect((await deleteOccurrence(db, owner, e, '2026-11-09', T0)).ok).toBe(true);
		expect(await run(at('2026-11-09', '09:50'))).toMatchObject({ sent: 0, rescheduled: 1 });
		expect((await reminderRow(db, r))?.fire_at).toBe(at('2026-11-16', '09:50'));
		await run(at('2026-11-16', '09:50'));
		expect((await reminderNotifications(db)).map((n) => n.occurrence_at)).toEqual([
			at('2026-11-02', '10:00'),
			at('2026-11-16', '10:00')
		]);
	});
});

describe('jobs run', () => {
	it('writes the heartbeat and purges only at 03:15 team time (27)', async () => {
		await runJobs({ DB: d1, TEAM_TIME_ZONE: JKT }, at('2026-11-02', '10:00'));
		expect(await jobsLastRun(db)).toBe(at('2026-11-02', '10:00'));

		const old = T0 - 100 * DAY_MS;
		const missed = await remind(personal('Old missed', old + 5 * MINUTE_MS), owner, old);
		const sent = await remind(personal('Old sent', old + 180 * MINUTE_MS), owner, old);
		const pending = await remind(personal('Future', T0 + 365 * DAY_MS), owner, T0);
		await run(old + 5 * MINUTE_MS + 25 * 60 * MINUTE_MS); // 25 h after Old missed, 22 h after Old sent
		expect(await reminderRow(db, missed)).toMatchObject({ outcome: 'missed' });
		expect(await reminderRow(db, sent)).toMatchObject({ outcome: 'sent' });

		expect((await runJobs({ DB: d1, TEAM_TIME_ZONE: JKT }, at('2026-11-02', '03:14'))).purged).toBe(
			0
		);
		const [before] = await reminderNotifications(db);
		expect(before).toMatchObject({ reminder_id: sent, summary: 'Old sent' });
		expect((await runJobs({ DB: d1, TEAM_TIME_ZONE: JKT }, at('2026-11-02', '03:15'))).purged).toBe(
			2
		);
		expect(await reminderRow(db, missed)).toBeNull();
		// QA F1: a sent reminder goes too; its notification stays, with the reminder link cleared.
		expect(await reminderRow(db, sent)).toBeNull();
		expect(await reminderNotifications(db)).toEqual([{ ...before, reminder_id: null }]);
		expect(await reminderRow(db, pending)).not.toBeNull();
		expect((await d1.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
		expect(await purgeClosed(d1, T0)).toBe(0);
	});
});

describe('e-mail (O5)', () => {
	it('off while REMINDER_EMAIL_FROM is empty or the binding is missing', () => {
		const send = vi.fn();
		expect(emailSender({ DB: d1, REMINDER_EMAIL_FROM: '', EMAIL: { send } })).toBeNull();
		expect(emailSender({ DB: d1, REMINDER_EMAIL_FROM: 'ruby@example.test' })).toBeNull();
		expect(
			emailSender({
				DB: d1,
				REMINDER_EMAIL_FROM: 'ruby@example.test',
				APP_HOST: 'ruby.example.invalid',
				EMAIL: { send }
			})?.origin
		).toBeNull();
		expect(
			emailSender({
				DB: d1,
				REMINDER_EMAIL_FROM: 'ruby@example.test',
				APP_HOST: 'ruby.example.test',
				EMAIL: { send }
			})?.origin
		).toBe('https://ruby.example.test');
		expect(
			emailSender({ DB: d1, REMINDER_EMAIL_FROM: 'ruby@example.test', EMAIL: { send } })?.from
		).toBe('ruby@example.test');
	});

	it('mails opted-in owners once per delivery; a failed send never blocks the in-app one', async () => {
		const fire = T0 + 5 * MINUTE_MS;
		const other = await insertUser(db);
		await d1
			.prepare(
				`INSERT INTO user_calendar_prefs (user_id, email_reminders, updated_at) VALUES (?1, 1, 1)`
			)
			.bind(owner.id)
			.run();
		await remind(personal('Mail me', fire));
		await remind(personal('Do not mail me', fire), other);
		const send = vi.fn().mockResolvedValue({ messageId: 'x' });
		const report = await run(fire, d1, {
			from: 'ruby@example.test',
			origin: 'https://ruby.example.test',
			send
		});
		expect(report).toMatchObject({ sent: 2, emailed: 1 });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0]).toMatchObject({
			from: 'ruby@example.test',
			to: owner.email,
			subject: 'Reminder: Mail me'
		});
		expect(send.mock.calls[0]?.[0].text).toContain('https://ruby.example.test/notifications');
		await run(fire, d1, { from: 'ruby@example.test', origin: 'https://ruby.example.test', send });
		expect(send).toHaveBeenCalledTimes(1);

		const failing = vi
			.fn()
			.mockRejectedValue(Object.assign(new Error('nope'), { code: 'E_SENDER_NOT_VERIFIED' }));
		await remind(personal('Mail fails', fire + 1));
		const r2 = await run(fire + 1, d1, { from: 'ruby@example.test', origin: null, send: failing });
		expect(r2).toMatchObject({ sent: 1, emailed: 0, failed: 0 });
		expect(await reminderNotifications(db, owner.id)).toHaveLength(2);
	});
});
