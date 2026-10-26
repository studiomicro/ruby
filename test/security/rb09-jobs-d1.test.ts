import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { dispatchDue, CLAIM_LEASE_MS } from '#lib/server/reminders/dispatch';
import { emailSender } from '#lib/server/reminders/jobs';
import { createReminder, deleteReminder, type ReminderRequest } from '#lib/server/reminders/repo';
import { MINUTE_MS } from '#lib/shared/calendar';
import { applyMigration, openLocalD1 } from '../helpers/d1';
import {
	at,
	clearCalendar,
	JKT,
	reminderNotifications,
	reminderRow,
	seedEvent
} from '../helpers/seed-calendar';
import { seedProject, seedTask } from '../helpers/seed-tasks';
import { insertUser } from '../helpers/users';

/**
 * RB-09 red team, the `ruby-jobs` scheduler against a fresh local D1 with an injected clock
 * (docs/features/rb-09-calendar-reminders/SECURITY_REPORT.md): claim and lease races, edit hooks that were missed,
 * deactivated owners, e-mail recipients and injection, and the 0011 rebuild's constraints. Every test asserts a
 * defence that holds. Fictional data only.
 */

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
let ana: SessionUser;
let bo: SessionUser;
let cy: SessionUser;

const T0 = at('2026-11-02', '08:00');
const FIRE = T0 + 10 * MINUTE_MS;

type Mail = { from: string; to: string; subject: string; text: string };
const mailer = (host = 'ruby.example.com') => {
	const sent: Mail[] = [];
	const sender = emailSender({
		DB: d1,
		REMINDER_EMAIL_FROM: 'ruby@example.com',
		APP_HOST: host,
		EMAIL: {
			send: async (m: Mail) => {
				sent.push(m);
			}
		}
	});
	return { sent, sender };
};
const run = (
	now: number,
	opts: { d?: D1Database; email?: ReturnType<typeof mailer>['sender'] } = {}
) => dispatchDue(opts.d ?? d1, now, { zone: JKT, email: opts.email ?? null });

async function remind(user: SessionUser, req: ReminderRequest, createdAt = T0) {
	const r = await createReminder(db, user.id, req, createdAt, JKT);
	if (!r.ok) throw new Error(`createReminder: ${r.reason}`);
	return r.id;
}
const optIn = (u: SessionUser) =>
	d1
		.prepare(
			`INSERT INTO user_calendar_prefs (user_id, email_reminders, updated_at) VALUES (?1, 1, 1)`
		)
		.bind(u.id)
		.run();
const allNotifications = async () =>
	(
		await d1
			.prepare(`SELECT user_id, kind, summary FROM notifications`)
			.all<{ user_id: string; summary: string }>()
	).results;

/** The real D1, except that its first `batch` waits until `release()` (a run stalled after its claim). */
function stalled() {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let reached!: () => void;
	const atGate = new Promise<void>((r) => (reached = r));
	let first = true;
	const db = {
		prepare: (q: string) => d1.prepare(q),
		batch: async (list: D1PreparedStatement[]) => {
			if (first) {
				first = false;
				reached();
				await gate;
			}
			return d1.batch(list);
		}
	} as unknown as D1Database;
	return { db, release, atGate };
}

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
	ana = await insertUser(db, { name: 'Ana Member', email: 'ana@example.test' });
	bo = await insertUser(db, { name: 'Bo Member', email: 'bo@example.test' });
	cy = await insertUser(db, { name: 'Cy Member', email: 'cy@example.test' });
});

describe('claim, lease and double send', () => {
	it('a run stalled past its lease: the next run re-claims and sends; the stalled run then writes nothing (one notification, one mail)', async () => {
		await optIn(bo);
		const id = await remind(bo, { kind: 'personal', title: 'Pay invoice', remindAt: FIRE });
		const mail = mailer();
		const a = stalled();
		const slow = run(FIRE, { d: a.db, email: mail.sender });
		await a.atGate; // A holds the claim and is about to load targets
		const claimed = await reminderRow(db, id);
		expect(claimed?.claim_until).toBe(FIRE + CLAIM_LEASE_MS);
		// Before the lease ends nobody else can take the row.
		expect((await run(FIRE + CLAIM_LEASE_MS - 1, { email: mail.sender })).claimed).toBe(0);
		const b = await run(FIRE + CLAIM_LEASE_MS + 1, { email: mail.sender });
		expect(b).toMatchObject({ claimed: 1, sent: 1, emailed: 1 });
		a.release();
		const late = await slow;
		expect(late).toMatchObject({ claimed: 1, sent: 0, emailed: 0 });
		expect(await reminderNotifications(db)).toHaveLength(1);
		expect(mail.sent).toHaveLength(1);
		expect((await reminderRow(db, id))?.outcome).toBe('sent');
	});

	it('20 overlapping runs over 60 due reminders: every reminder exactly once', async () => {
		const ids: string[] = [];
		for (let i = 0; i < 60; i++)
			ids.push(
				await remind(i % 2 ? bo : cy, { kind: 'personal', title: `R${i}`, remindAt: FIRE + i })
			);
		const reports = await Promise.all(Array.from({ length: 20 }, () => run(FIRE + 100)));
		expect(reports.reduce((n, r) => n + r.sent, 0)).toBe(60);
		const rows = await reminderNotifications(db);
		expect(rows).toHaveLength(60);
		expect(new Set(rows.map((r) => r.reminder_id)).size).toBe(60);
	});

	it('a delete that lands after the claim but before the send: nothing is delivered', async () => {
		const id = await remind(bo, { kind: 'personal', title: 'Deleted meanwhile', remindAt: FIRE });
		const a = stalled();
		const pending = run(FIRE, { d: a.db });
		await a.atGate;
		expect(await deleteReminder(db, bo.id, id, FIRE)).toBe(true);
		a.release();
		expect((await pending).sent).toBe(0);
		expect(await allNotifications()).toEqual([]);
	});

	it('the notification key (reminder, occurrence) refuses a second row even outside the claim guard', async () => {
		const id = await remind(bo, { kind: 'personal', title: 'Once', remindAt: FIRE });
		await run(FIRE);
		await expect(
			d1
				.prepare(
					`INSERT INTO notifications (id, user_id, kind, actor_id, target_kind, target_id, summary, reminder_id, occurrence_at, created_at)
					 VALUES (?1, ?2, 'reminder', ?2, 'personal', ?3, 'dup', ?3, ?4, 1)`
				)
				.bind(crypto.randomUUID(), bo.id, id, FIRE)
				.run()
		).rejects.toThrow(/UNIQUE/);
	});
});

describe('live-target rules even when an edit hook was missed', () => {
	it('a team event flipped to private behind the hooks: the non-participant gets nothing', async () => {
		const ev = await seedEvent(
			db,
			ana,
			{ startAt: FIRE + 60 * MINUTE_MS, endAt: FIRE + 120 * MINUTE_MS, title: 'Zq7 plan' },
			T0
		);
		const id = await remind(bo, { kind: 'event', eventId: ev, offset: 60 });
		expect((await reminderRow(db, id))?.fire_at).toBe(FIRE);
		await d1.prepare(`UPDATE events SET visibility = 'private' WHERE id = ?1`).bind(ev).run();
		await optIn(bo);
		const mail = mailer();
		expect(await run(FIRE, { email: mail.sender })).toMatchObject({ sent: 0, canceled: 1 });
		expect(await allNotifications()).toEqual([]);
		expect(mail.sent).toEqual([]);
	});

	it('an attendee row removed behind the hooks: the removed user gets nothing; a remaining attendee does', async () => {
		const ev = await seedEvent(
			db,
			ana,
			{
				visibility: 'private',
				attendeeIds: [bo.id, cy.id],
				startAt: FIRE + 10 * MINUTE_MS,
				endAt: FIRE + 70 * MINUTE_MS,
				title: 'Zq7 review'
			},
			T0
		);
		const boR = await remind(bo, { kind: 'event', eventId: ev, offset: 10 });
		const cyR = await remind(cy, { kind: 'event', eventId: ev, offset: 10 });
		await d1
			.prepare(`DELETE FROM event_attendees WHERE event_id = ?1 AND user_id = ?2`)
			.bind(ev, bo.id)
			.run();
		await run(FIRE);
		expect((await reminderRow(db, boR))?.outcome).toBe('canceled');
		expect((await reminderRow(db, cyR))?.outcome).toBe('sent');
		const rows = await allNotifications();
		expect(rows.map((r) => r.user_id)).toEqual([cy.id]); // never the creator, never the removed attendee
	});

	it('an owner deactivated after creating reminders: canceled, no notification, no mail', async () => {
		await optIn(bo);
		const id = await remind(bo, { kind: 'personal', title: 'Gone owner', remindAt: FIRE });
		await d1.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?1`).bind(bo.id).run();
		const mail = mailer();
		expect(await run(FIRE, { email: mail.sender })).toMatchObject({ canceled: 1, sent: 0 });
		expect((await reminderRow(db, id))?.outcome).toBe('canceled');
		expect(await allNotifications()).toEqual([]);
		expect(mail.sent).toEqual([]);
	});

	it('a task deleted or its project deleted behind the hooks: canceled', async () => {
		const p = await seedProject(db, ana, { key: 'JOB' });
		const t1 = await seedTask(db, ana, p, {});
		const p2 = await seedProject(db, ana, { key: 'JOC' });
		const t2 = await seedTask(db, ana, p2, {});
		const a = await remind(bo, { kind: 'task', taskId: t1.id, mode: 'absolute', remindAt: FIRE });
		const b = await remind(bo, { kind: 'task', taskId: t2.id, mode: 'absolute', remindAt: FIRE });
		await d1.prepare(`UPDATE tasks SET deleted_at = 1 WHERE id = ?1`).bind(t1.id).run();
		await d1.prepare(`UPDATE projects SET deleted_at = 1 WHERE id = ?1`).bind(p2.id).run();
		await run(FIRE);
		expect((await reminderRow(db, a))?.outcome).toBe('canceled');
		expect((await reminderRow(db, b))?.outcome).toBe('canceled');
		expect(await allNotifications()).toEqual([]);
	});
});

describe('reminder e-mail', () => {
	it('goes only to the opted-in owner; a CRLF/HTML title cannot add headers or recipients; links from APP_HOST', async () => {
		const p = await seedProject(db, ana, { key: 'MAIL' });
		const task = await seedTask(db, ana, p, { dueOn: '2026-11-03' });
		const evil = `Fix\r\nBcc: victim@evil.test\r\nContent-Type: text/html\r\n\r\n<a href="https://evil.test">login</a>`;
		await d1.prepare(`UPDATE tasks SET title = ?2 WHERE id = ?1`).bind(task.id, evil).run();
		await optIn(bo);
		await remind(bo, { kind: 'task', taskId: task.id, mode: 'absolute', remindAt: FIRE });
		await remind(cy, { kind: 'task', taskId: task.id, mode: 'absolute', remindAt: FIRE }); // cy did not opt in
		const mail = mailer('Ruby.Example.COM');
		await run(FIRE, { email: mail.sender });
		expect(mail.sent).toHaveLength(1);
		const [m] = mail.sent;
		expect(Object.keys(m!).sort()).toEqual(['from', 'subject', 'text', 'to']); // no html part
		expect(m!.to).toBe('bo@example.test');
		expect(m!.from).toBe('ruby@example.com');
		expect(m!.subject).not.toMatch(/[\r\n]/);
		expect(m!.subject.startsWith('Reminder: MAIL-1 Fix Bcc: victim@evil.test')).toBe(true);
		const firstLine = m!.text.split('\n')[0]!;
		expect(firstLine).not.toMatch(/\r/);
		expect(m!.text.split('\n\n')).toHaveLength(3); // summary, inbox link, footer: nothing injected between
		expect(m!.text.match(/https:\/\/[^\s"]+/g)).toEqual([
			'https://evil.test', // inside the literal title text of a text/plain body
			'https://ruby.example.com/notifications',
			'https://ruby.example.com/account'
		]);
		expect((await allNotifications()).map((r) => r.user_id).sort()).toEqual([bo.id, cy.id].sort());
	});

	it('a private event reminder mails the participant who set it and nobody else', async () => {
		const ev = await seedEvent(
			db,
			ana,
			{
				visibility: 'private',
				attendeeIds: [bo.id, cy.id],
				startAt: FIRE + 30 * MINUTE_MS,
				endAt: FIRE + 90 * MINUTE_MS,
				title: 'Zq7 salary talk'
			},
			T0
		);
		for (const u of [ana, bo, cy]) await optIn(u);
		await remind(bo, { kind: 'event', eventId: ev, offset: 30 });
		const mail = mailer();
		await run(FIRE, { email: mail.sender });
		expect(mail.sent.map((m) => m.to)).toEqual(['bo@example.test']);
		expect((await allNotifications()).map((r) => r.user_id)).toEqual([bo.id]);
	});
});

describe('migration 0011 constraints on a database with data', () => {
	it('foreign keys and CHECKs are enforced on the rebuilt notifications and the new tables', async () => {
		const opened = await openLocalD1({ before: '0011' });
		const x = opened.db;
		try {
			const t = 1_790_000_000_000;
			const u = '00000000-0000-4000-8000-000000000001';
			await x
				.prepare(
					`INSERT INTO users (id, email, name, role, status, created_at) VALUES (?1, 'a@example.test', 'A', 'admin', 'active', ?2)`
				)
				.bind(u, t)
				.run();
			await x
				.prepare(
					`INSERT INTO projects (id, key, name, status, next_task_number, created_by, created_at, updated_at) VALUES ('p1', 'OPS', 'Ops', 'active', 2, ?1, ?2, ?2)`
				)
				.bind(u, t)
				.run();
			await x
				.prepare(
					`INSERT INTO tasks (id, project_id, number, title, status, priority, position, created_by, created_at, updated_at) VALUES ('t1', 'p1', 1, 'T', 'todo', 'none', 1, ?1, ?2, ?2)`
				)
				.bind(u, t)
				.run();
			for (let i = 0; i < 120; i++)
				await x
					.prepare(
						`INSERT INTO notifications (id, user_id, kind, actor_id, target_kind, target_id, created_at, read_at) VALUES (?1, ?2, 'assigned', ?2, 'task', 't1', ?3, ?4)`
					)
					.bind(`n${i}`, u, t + i, i % 3 ? null : t + 999)
					.run();
			const before = (await x.prepare(`SELECT * FROM notifications ORDER BY id`).all()).results;
			await applyMigration(x, '0011_calendar_reminders.sql');
			const after = (
				await x
					.prepare(
						`SELECT id, user_id, kind, actor_id, target_kind, target_id, comment_id, created_at, read_at FROM notifications ORDER BY id`
					)
					.all()
			).results;
			expect(after).toEqual(before);
			expect((await x.prepare(`PRAGMA foreign_key_check`).all()).results).toEqual([]);
			const bad = (sql: string) =>
				expect(x.prepare(sql).run()).rejects.toThrow(/FOREIGN KEY|CHECK|NOT NULL/);
			await bad(
				`INSERT INTO notifications (id, user_id, kind, actor_id, target_kind, target_id, created_at) VALUES ('z1', 'nobody', 'mention', '${u}', 'task', 't1', 1)`
			);
			await bad(
				`INSERT INTO notifications (id, user_id, kind, actor_id, target_kind, target_id, reminder_id, occurrence_at, created_at) VALUES ('z2', '${u}', 'reminder', '${u}', 'personal', 'r', 'no-such-reminder', 1, 1)`
			);
			await bad(
				`INSERT INTO reminders (id, user_id, target_kind, target_id, mode, offset_min, fire_at, created_at, updated_at) VALUES ('r1', '${u}', 'task', 't1', 'relative', 99999, 1, 1, 1)`
			);
			await bad(
				`INSERT INTO reminders (id, user_id, target_kind, target_id, mode, remind_at, fire_at, created_at, updated_at) VALUES ('r2', '${u}', 'personal', 't1', 'absolute', 1, 1, 1, 1)`
			);
			await bad(
				`INSERT INTO reminders (id, user_id, target_kind, mode, remind_at, fire_at, created_at, updated_at, done_at) VALUES ('r3', '${u}', 'personal', 'absolute', 1, 1, 1, 1, 5)`
			);
			await bad(
				`INSERT INTO reminders (id, user_id, target_kind, mode, remind_at, fire_at, created_at, updated_at) VALUES ('r4', 'nobody', 'personal', 'absolute', 1, 1, 1, 1)`
			);
			await bad(
				`INSERT INTO events (id, title, all_day, start_at, end_at, first_on, last_on, visibility, created_by, created_at, updated_at) VALUES ('e1', 'x', 0, 1, 2, '2026-01-01', '2026-01-01', 'public', '${u}', 1, 1)`
			);
			await bad(
				`INSERT INTO events (id, title, all_day, start_at, end_at, first_on, last_on, rec_freq, created_by, created_at, updated_at) VALUES ('e2', 'x', 0, 1, 2, '2026-01-01', '2026-01-01', 'daily', '${u}', 1, 1)`
			);
			await bad(
				`INSERT INTO events (id, title, all_day, start_at, end_at, first_on, last_on, rec_freq, rec_interval, rec_until_on, created_by, created_at, updated_at) VALUES ('e3', 'x', 0, 1, 2, '2026-01-01', '2026-01-01', 'daily', 0, '2026-01-02', '${u}', 1, 1)`
			);
			await bad(
				`INSERT INTO event_attendees (event_id, user_id, created_at) VALUES ('no-event', '${u}', 1)`
			);
			await bad(
				`INSERT INTO user_calendar_prefs (user_id, email_reminders, updated_at) VALUES ('${u}', 2, 1)`
			);
		} finally {
			await opened.dispose();
		}
	});
});
