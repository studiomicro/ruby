import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionCookieName, type SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { createEvent, deleteEvent, getVisibleEvent, updateEvent } from '#lib/server/events/repo';
import { purgeClosed } from '#lib/server/reminders/jobs';
import { reminderPanel } from '#lib/server/reminders/panel';
import { createReminder, deleteReminder, listMyReminders } from '#lib/server/reminders/repo';
import { DAY_MS, MINUTE_MS } from '#lib/shared/calendar';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import {
	at,
	clearCalendar,
	eventInput,
	JKT,
	reminderRow,
	seedEvent
} from '../helpers/seed-calendar';
import { seedProject, seedTask } from '../helpers/seed-tasks';
import { insertSession, insertUser } from '../helpers/users';

/**
 * RB-09 red team, loads, actions and repositories against a fresh local D1
 * (docs/features/rb-09-calendar-reminders/SECURITY_REPORT.md). Tests named `PROOF` document a finding (they assert
 * the weak behaviour as it ships); every other test asserts a defence that holds. Fictional data only.
 */

const binding: Record<string, unknown> = {
	TEAM_TIME_ZONE: 'Asia/Jakarta',
	REMINDER_EMAIL_FROM: '',
	ACCESS_TEAM_DOMAIN: '',
	ACCESS_AUD: ''
};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const calendar = await import('../../src/routes/(app)/calendar/+page.server');
const detail = await import('../../src/routes/(app)/calendar/events/[id]/+page.server');
const edit = await import('../../src/routes/(app)/calendar/events/[id]/edit/+page.server');
const remindersPage = await import('../../src/routes/(app)/reminders/+page.server');
const taskPage = await import('../../src/routes/(app)/projects/[key]/tasks/[number]/+page.server');
const account = await import('../../src/routes/(app)/account/+page.server');
const adminEvents = await import('../../src/routes/(app)/admin/events/+page.server');
const { handle } = await import('../../src/hooks.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
let admin: SessionUser;
let ana: SessionUser;
let bo: SessionUser;
let cy: SessionUser;

type Fn = (event: never) => unknown;
async function call(fn: unknown, event: unknown): Promise<unknown> {
	try {
		return await (fn as Fn)(event as never);
	} catch (e) {
		return e;
	}
}
const status = (x: unknown) =>
	isHttpError(x) ? x.status : isRedirect(x) ? x.status : isActionFailure(x) ? x.status : 200;
const ev = (
	path: string,
	user: SessionUser | null,
	options: {
		form?: Record<string, string> | [string, string][];
		params?: Record<string, string>;
	} = {}
) => fakeEvent({ url: `http://localhost${path}`, db, user: user ?? undefined, ...options }).event;

const NOW = at('2026-11-01', '12:00');

beforeAll(async () => {
	const opened = await openLocalD1();
	d1 = opened.db;
	db = getDb(opened.db);
	binding.DB = opened.db;
	dispose = opened.dispose;
});
afterAll(() => dispose());
beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	await clearCalendar(db);
	admin = await insertUser(db, { role: 'admin', name: 'Ada Admin' });
	ana = await insertUser(db, { name: 'Ana Member' });
	bo = await insertUser(db, { name: 'Bo Member' });
	cy = await insertUser(db, { name: 'Cy Member' });
	vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const SECRET = 'Zq7Secret';
const privateSeries = () =>
	seedEvent(
		db,
		ana,
		{
			visibility: 'private',
			attendeeIds: [bo.id],
			title: `${SECRET} 1:1`,
			location: `${SECRET} room`,
			description: `${SECRET} agenda`,
			recFreq: 'weekly',
			recInterval: 1,
			recUntilOn: '2026-11-16'
		},
		NOW
	);

// ── Private events ───────────────────────────────────────────────────────────────────────────────────────────

describe('private events: admin and third members see nothing, anywhere', () => {
	it('calendar payloads (every view and filter), detail, edit, delete, occurrence delete and reminders', async () => {
		const id = await privateSeries();
		const params = { id };
		for (const viewer of [admin, cy]) {
			for (const q of [
				'view=month&date=2026-11-02',
				'view=week&date=2026-11-02',
				'view=agenda&date=2026-11-02',
				'date=2026-11-02',
				'date=2026-11-02&mine=1&show=events',
				'date=2026-11-02&show=events&done=1&tasks=all'
			]) {
				const page = await call(calendar.load, ev(`/calendar?${q}`, viewer));
				expect(status(page)).toBe(200);
				const json = JSON.stringify(page);
				expect(json, q).not.toContain(SECRET);
				expect(json, q).not.toContain(id);
				expect((page as { capped: boolean }).capped).toBe(false);
			}
			const refusals: [unknown, string, Record<string, string> | undefined][] = [
				[detail.load, `/calendar/events/${id}?on=2026-11-09`, undefined],
				[edit.load, `/calendar/events/${id}/edit`, undefined],
				[detail.actions.remove, `/calendar/events/${id}`, { confirm: 'yes' }],
				[detail.actions.removeOccurrence, `/calendar/events/${id}`, { on: '2026-11-09' }],
				[detail.actions.reminderAdd, `/calendar/events/${id}`, { offset: '10' }],
				[
					edit.actions.update,
					`/calendar/events/${id}/edit`,
					{
						title: 'Hijack',
						startDate: '2026-11-02',
						startTime: '14:00',
						endDate: '2026-11-02',
						endTime: '15:00',
						expectedUpdatedAt: String(NOW)
					}
				]
			];
			for (const [fn, path, form] of refusals) {
				const r = await call(fn, ev(path, viewer, { form, params }));
				expect(status(r), `${viewer.name} ${path}`).toBe(404);
				expect(JSON.stringify(r)).not.toContain(SECRET);
			}
			expect(
				await createReminder(db, viewer.id, { kind: 'event', eventId: id, offset: 10 }, NOW, JKT)
			).toEqual({ ok: false, reason: 'not_found' });
			expect(await getVisibleEvent(db, viewer.id, id)).toBeNull();
			expect(await deleteEvent(db, viewer, id, NOW)).toEqual({ ok: false, reason: 'not_found' });
		}
		const row = await d1
			.prepare(`SELECT title, deleted_at FROM events WHERE id = ?1`)
			.bind(id)
			.first<{ title: string; deleted_at: number | null }>();
		expect(row).toEqual({ title: `${SECRET} 1:1`, deleted_at: null });
		expect(
			(await d1.prepare(`SELECT count(*) AS n FROM event_exceptions`).first<{ n: number }>())?.n
		).toBe(0);
	});

	it('an attendee removed from a private event loses it at once: detail, calendar, reminder list', async () => {
		const id = await privateSeries();
		const made = await createReminder(
			db,
			bo.id,
			{ kind: 'event', eventId: id, offset: 10 },
			NOW,
			JKT
		);
		expect(made.ok).toBe(true);
		const before = await getVisibleEvent(db, ana.id, id);
		const removed = await updateEvent(
			db,
			ana,
			id,
			eventInput({
				visibility: 'private',
				attendeeIds: [],
				title: `${SECRET} 1:1`,
				recFreq: 'weekly',
				recInterval: 1,
				recUntilOn: '2026-11-16'
			}),
			before!.updatedAt,
			NOW + 1
		);
		expect(removed).toEqual({ ok: true });
		expect(
			status(await call(detail.load, ev(`/calendar/events/${id}`, bo, { params: { id } })))
		).toBe(404);
		const cal = await call(calendar.load, ev('/calendar?view=month&date=2026-11-02', bo));
		expect(JSON.stringify(cal)).not.toContain(SECRET);
		const mine = await call(remindersPage.load, ev('/reminders', bo));
		expect(JSON.stringify(mine)).not.toContain(SECRET);
		// The pending reminder is sent back to the jobs Worker, which cancels it (rb09-jobs-d1.test.ts).
		expect((await reminderRow(db, made.ok ? made.id : ''))?.fire_at).toBe(NOW + 1);
	});
});

// ── IDOR on reminders ────────────────────────────────────────────────────────────────────────────────────────

describe('reminders belong to their owner only (admin included)', () => {
	it('another user cannot remove, list or see a reminder by id, on any page; the row stays', async () => {
		const p = await seedProject(db, ana, { key: 'IDR' });
		const task = await seedTask(db, ana, p, { dueOn: '2026-11-20' });
		const teamEvent = await seedEvent(db, ana, { title: 'Town hall' }, NOW);
		const ids: string[] = [];
		for (const req of [
			{ kind: 'task', taskId: task.id, mode: 'absolute', remindAt: at('2026-11-10', '09:00') },
			{ kind: 'event', eventId: teamEvent, offset: 60 },
			{ kind: 'personal', title: `${SECRET} dentist`, remindAt: at('2026-11-10', '09:00') }
		] as const) {
			const r = await createReminder(db, ana.id, req, NOW, JKT);
			if (!r.ok) throw new Error(r.reason);
			ids.push(r.id);
		}
		for (const viewer of [bo, admin]) {
			for (const id of ids)
				for (const variant of [id, id.toUpperCase()]) {
					expect(
						status(
							await call(
								remindersPage.actions.remove,
								ev('/reminders', viewer, { form: { id: variant } })
							)
						)
					).toBe(404);
					expect(
						status(
							await call(
								taskPage.actions.reminderRemove,
								ev(`/projects/IDR/tasks/${task.number}`, viewer, {
									params: { key: 'IDR', number: String(task.number) },
									form: { id: variant }
								})
							)
						)
					).toBe(404);
					expect(
						status(
							await call(
								detail.actions.reminderRemove,
								ev(`/calendar/events/${teamEvent}`, viewer, {
									params: { id: teamEvent },
									form: { id: variant }
								})
							)
						)
					).toBe(404);
					expect(await deleteReminder(db, viewer.id, id, NOW)).toBe(false);
				}
			const pages = [
				await call(remindersPage.load, ev('/reminders', viewer)),
				await reminderPanel(db, viewer, { kind: 'task', id: task.id, dueOn: '2026-11-20' }),
				await reminderPanel(db, viewer, { kind: 'event', id: teamEvent }),
				await listMyReminders(db, viewer.id)
			];
			const json = JSON.stringify(pages);
			for (const id of ids) expect(json).not.toContain(id);
			expect(json).not.toContain(SECRET);
		}
		for (const id of ids) expect((await reminderRow(db, id))?.deleted_at).toBeNull();
	});

	it('tampered reminder forms: unknown offsets, wrong preset family, past and far times are refused', async () => {
		const p = await seedProject(db, ana, { key: 'TMP' });
		const task = await seedTask(db, ana, p, { dueOn: '2026-11-20' });
		const event = await seedEvent(
			db,
			ana,
			{ startAt: at('2026-11-20', '14:00'), endAt: at('2026-11-20', '15:00') },
			NOW
		);
		const taskAdd = (form: Record<string, string>) =>
			call(
				taskPage.actions.reminderAdd,
				ev(`/projects/TMP/tasks/${task.number}`, ana, {
					params: { key: 'TMP', number: String(task.number) },
					form
				})
			);
		const eventAdd = (form: Record<string, string>) =>
			call(
				detail.actions.reminderAdd,
				ev(`/calendar/events/${event}`, ana, { params: { id: event }, form })
			);
		for (const offset of [
			'99999',
			'-1',
			'10',
			'0x10',
			' 0',
			'1440.0',
			'1e3',
			'',
			'00000000000000001440'
		])
			expect(status(await taskAdd({ offset })), `task ${offset}`).toBe(400);
		for (const offset of ['2880', '5', '100000'])
			expect(status(await eventAdd({ offset })), `event ${offset}`).toBe(400);
		// "absolute" is a task-only mode: on an event it is the offset path, and no offset is refused.
		expect(status(await eventAdd({ mode: 'absolute', date: '2026-11-19', time: '09:00' }))).toBe(
			400
		);
		for (const [date, time] of [
			['2026-11-01', '12:00'], // now: under a minute ahead
			['2000-01-01', '00:00'],
			['2028-11-02', '12:00'], // over two years
			['2100-12-31', '23:59'],
			['2026-02-29', '09:00'],
			['2026-11-10', '24:00'],
			['2026-11-10', '9:00']
		] as [string, string][])
			expect(status(await taskAdd({ mode: 'absolute', date, time })), `${date} ${time}`).toBe(400);
		expect(
			(await d1.prepare(`SELECT count(*) AS n FROM reminders`).first<{ n: number }>())?.n
		).toBe(0);
		// The personal form: the same date and time rules.
		for (const [date, time] of [
			['2026-11-01', '12:00'],
			['2028-11-02', '12:00'],
			['20261110', '0900']
		] as [string, string][])
			expect(
				status(
					await call(
						remindersPage.actions.create,
						ev('/reminders', ana, { form: { title: 'x', date, time } })
					)
				)
			).toBe(400);
	});

	it('targets the user cannot see or that are gone: 404 / not_found, no row', async () => {
		const p = await seedProject(db, ana, { key: 'GON' });
		const task = await seedTask(db, ana, p, { dueOn: '2026-11-20' });
		await d1.prepare(`UPDATE tasks SET deleted_at = 1 WHERE id = ?1`).bind(task.id).run();
		const gone = await seedEvent(
			db,
			ana,
			{ startAt: at('2026-11-20', '14:00'), endAt: at('2026-11-20', '15:00') },
			NOW
		);
		await deleteEvent(db, ana, gone, NOW);
		for (const req of [
			{ kind: 'task', taskId: task.id, mode: 'relative', offset: 0 },
			{ kind: 'task', taskId: task.id, mode: 'absolute', remindAt: at('2026-11-10', '09:00') },
			{
				kind: 'task',
				taskId: crypto.randomUUID(),
				mode: 'absolute',
				remindAt: at('2026-11-10', '09:00')
			},
			{ kind: 'event', eventId: gone, offset: 0 },
			{ kind: 'event', eventId: crypto.randomUUID(), offset: 0 }
		] as const)
			expect(await createReminder(db, bo.id, req, NOW, JKT)).toEqual({
				ok: false,
				reason: 'not_found'
			});
		expect(
			status(
				await call(
					taskPage.actions.reminderAdd,
					ev(`/projects/GON/tasks/${task.number}`, bo, {
						params: { key: 'GON', number: String(task.number) },
						form: { offset: '0' }
					})
				)
			)
		).toBe(404);
		expect(
			(await d1.prepare(`SELECT count(*) AS n FROM reminders`).first<{ n: number }>())?.n
		).toBe(0);
	});
});

// ── Caps and races ───────────────────────────────────────────────────────────────────────────────────────────

describe('caps hold under 20 concurrent requests', () => {
	it('10 per target: 20 concurrent distinct reminders on one task store exactly 10', async () => {
		const p = await seedProject(db, ana, { key: 'CAP' });
		const task = await seedTask(db, ana, p, {});
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				createReminder(
					db,
					bo.id,
					{
						kind: 'task',
						taskId: task.id,
						mode: 'absolute',
						remindAt: NOW + DAY_MS + i * MINUTE_MS
					},
					NOW,
					JKT
				)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(10);
		expect(results.filter((r) => !r.ok && r.reason === 'target_limit')).toHaveLength(10);
		expect(
			(
				await d1
					.prepare(`SELECT count(*) AS n FROM reminders WHERE user_id = ?1`)
					.bind(bo.id)
					.first<{ n: number }>()
			)?.n
		).toBe(10);
	});

	it('dedupe: 20 concurrent identical creates leave one row and all answer ok', async () => {
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				createReminder(
					db,
					bo.id,
					{ kind: 'personal', title: 'Same', remindAt: NOW + DAY_MS },
					NOW,
					JKT
				)
			)
		);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(new Set(results.map((r) => (r.ok ? r.id : ''))).size).toBe(1);
	});

	it('200 pending per user: from 195, 20 concurrent creates add exactly 5', async () => {
		for (let i = 0; i < 195; i++)
			await createReminder(
				db,
				bo.id,
				{ kind: 'personal', title: `P${i}`, remindAt: NOW + DAY_MS + i },
				NOW,
				JKT
			);
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				createReminder(
					db,
					bo.id,
					{ kind: 'personal', title: `Q${i}`, remindAt: NOW + 2 * DAY_MS },
					NOW,
					JKT
				)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(5);
		expect(results.filter((r) => !r.ok && r.reason === 'user_limit')).toHaveLength(15);
	});

	it('100 events per user per day: from 95, 20 concurrent creates add exactly 5; deleting does not reset it', async () => {
		const ids: string[] = [];
		for (let i = 0; i < 95; i++) ids.push(await seedEvent(db, bo, { title: `E${i}` }, NOW));
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				createEvent(db, bo, eventInput({ title: `C${i}` }), NOW + 1)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(5);
		expect(results.filter((r) => !r.ok && r.reason === 'daily_limit')).toHaveLength(15);
		for (const id of ids) await deleteEvent(db, bo, id, NOW + 2);
		expect(await createEvent(db, bo, eventInput(), NOW + 3)).toEqual({
			ok: false,
			reason: 'daily_limit'
		});
		expect((await createEvent(db, bo, eventInput(), NOW + DAY_MS + 3)).ok).toBe(true);
	});

	it('recurrence explosion: 30 daily 500-occurrence series in one month view stay at 1000 items, capped', async () => {
		for (let i = 0; i < 30; i++)
			await seedEvent(
				db,
				ana,
				{ title: `Daily ${i}`, recFreq: 'daily', recInterval: 1, recUntilOn: '2028-03-15' },
				NOW
			);
		const page = (await call(
			calendar.load,
			ev('/calendar?view=month&date=2026-11-15&show=events', cy)
		)) as {
			items: unknown[];
			capped: boolean;
		};
		expect(page.items.length).toBe(1000);
		expect(page.capped).toBe(true);
	});
});

// ── Findings ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('findings', () => {
	it("FIXED L1 (was PROOF): the event cap is per creator, a deactivated user's private events stop counting, and an admin purges them by count only", async () => {
		const mal = await insertUser(db, { name: 'Mal Member' });
		const start = at('2026-11-02', '14:00');
		// 499 private events created earlier (outside the 100-a-day window), plus one through the repository: 500.
		await d1
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 499)
				 INSERT INTO events (id, title, all_day, start_at, end_at, first_on, last_on, visibility, created_by, created_at, updated_at)
				 SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-8'
				        || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
				        'Secret title', 0, ?1, ?2, '2026-11-02', '2026-11-02', 'private', ?3, ?4, ?4 FROM n`
			)
			.bind(start, start + 3_600_000, mal.id, NOW - 30 * DAY_MS)
			.run();
		const lastId = await seedEvent(db, mal, { visibility: 'private', attendeeIds: [bo.id] }, NOW);
		expect(await createEvent(db, mal, eventInput(), NOW)).toEqual({
			ok: false,
			reason: 'live_limit'
		});
		// Everyone else is unaffected.
		expect((await createEvent(db, admin, eventInput(), NOW)).ok).toBe(true);
		expect((await createEvent(db, ana, eventInput(), NOW)).ok).toBe(true);
		// O2 still holds: the admin can neither see nor delete them one by one.
		expect(await deleteEvent(db, admin, lastId, NOW)).toEqual({ ok: false, reason: 'not_found' });
		expect(await getVisibleEvent(db, bo.id, lastId)).not.toBeNull();

		// Deactivated: the private events vanish for attendees at once and count toward nothing.
		await d1.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?1`).bind(mal.id).run();
		expect(await getVisibleEvent(db, bo.id, lastId)).toBeNull();
		const cal = (await call(
			calendar.load,
			ev('/calendar?view=month&date=2026-11-02&show=events&mine=1', bo)
		)) as {
			items: unknown[];
		};
		expect(cal.items).toEqual([]);

		// The admin page shows a count, never a title; the purge is audited with the count only.
		const page = (await call(adminEvents.load, ev('/admin/events', admin))) as {
			candidates: { userId: string; name: string; events: number }[];
		};
		expect(page.candidates).toEqual([{ userId: mal.id, name: 'Mal Member', events: 500 }]);
		expect(JSON.stringify(page)).not.toContain('Secret title');
		expect(status(await call(adminEvents.load, ev('/admin/events', ana)))).toBe(403);
		expect(
			status(
				await call(
					adminEvents.actions.purge,
					ev('/admin/events', ana, { form: { userId: mal.id, confirm: 'yes' } })
				)
			)
		).toBe(403);
		expect(
			status(
				await call(
					adminEvents.actions.purge,
					ev('/admin/events', admin, { form: { userId: mal.id } })
				)
			)
		).toBe(400);
		// An active user's events are never purged.
		expect(
			status(
				await call(
					adminEvents.actions.purge,
					ev('/admin/events', admin, { form: { userId: ana.id, confirm: 'yes' } })
				)
			)
		).toBe(409);
		const purged = await call(
			adminEvents.actions.purge,
			ev('/admin/events', admin, { form: { userId: mal.id, confirm: 'yes' } })
		);
		expect(purged).toEqual({ purged: 500 });
		expect(
			(
				await d1
					.prepare(`SELECT count(*) AS n FROM events WHERE created_by = ?1 AND deleted_at IS NULL`)
					.bind(mal.id)
					.first<{ n: number }>()
			)?.n
		).toBe(0);
		const audit = await d1
			.prepare(
				`SELECT actor_id AS actor, action, user_id AS user, fields, detail FROM hr_audit_log WHERE action = 'calendar_events_purge'`
			)
			.all();
		expect(audit.results).toEqual([
			{
				actor: admin.id,
				action: 'calendar_events_purge',
				user: mal.id,
				fields: '["deleted_at"]',
				detail: '500 events'
			}
		]);
		expect(
			status(
				await call(
					adminEvents.actions.purge,
					ev('/admin/events', admin, { form: { userId: mal.id, confirm: 'yes' } })
				)
			)
		).toBe(409);
	});

	it('FIXED L2 (was PROOF): reminder creates are capped at 300 a day, deleted ones included; purge still clears them', async () => {
		for (let i = 0; i < 300; i++) {
			const r = await createReminder(
				db,
				bo.id,
				{ kind: 'personal', title: 'Loop', remindAt: NOW + DAY_MS },
				NOW,
				JKT
			);
			if (!r.ok) throw new Error(r.reason);
			expect(await deleteReminder(db, bo.id, r.id, NOW)).toBe(true);
		}
		expect(
			await createReminder(
				db,
				bo.id,
				{ kind: 'personal', title: 'Loop', remindAt: NOW + DAY_MS },
				NOW,
				JKT
			)
		).toEqual({ ok: false, reason: 'daily_limit' });
		const form = { title: 'Over', date: '2026-11-03', time: '09:00' };
		expect(status(await call(remindersPage.actions.create, ev('/reminders', bo, { form })))).toBe(
			429
		);
		// Other users are not affected, and the next day the budget is back.
		expect(
			(
				await createReminder(
					db,
					cy.id,
					{ kind: 'personal', title: 'Mine', remindAt: NOW + DAY_MS },
					NOW,
					JKT
				)
			).ok
		).toBe(true);
		expect(
			(
				await createReminder(
					db,
					bo.id,
					{ kind: 'personal', title: 'Tomorrow', remindAt: NOW + 2 * DAY_MS },
					NOW + DAY_MS + 1,
					JKT
				)
			).ok
		).toBe(true);
		expect(
			(
				await d1
					.prepare(`SELECT count(*) AS n FROM reminders WHERE user_id = ?1`)
					.bind(bo.id)
					.first<{ n: number }>()
			)?.n
		).toBe(301);
		expect(await purgeClosed(d1, NOW + 89 * DAY_MS)).toBe(0);
		expect(await purgeClosed(d1, NOW + 91 * DAY_MS)).toBe(300);
	});
});

// ── Web basics through the real hook: CSRF, cache, deactivated sessions ──────────────────────────────────────

describe('hooks: CSRF on every RB-09 action, no-store, deactivated users', () => {
	const resolve = vi.fn(
		async () => new Response('<p>ok</p>', { headers: { 'content-type': 'text/html' } })
	);
	const hook = async (init: Parameters<typeof fakeEvent>[0]) => {
		resolve.mockClear();
		const { event } = fakeEvent(init);
		const response = await handle({ event, resolve } as never);
		return { response, resolved: resolve.mock.calls.length };
	};
	const ACTIONS: [string, string][] = [
		['/calendar/events/new?/create', '/(app)/calendar/events/new'],
		[`/calendar/events/${crypto.randomUUID()}?/remove`, '/(app)/calendar/events/[id]'],
		[`/calendar/events/${crypto.randomUUID()}?/removeOccurrence`, '/(app)/calendar/events/[id]'],
		[`/calendar/events/${crypto.randomUUID()}?/reminderAdd`, '/(app)/calendar/events/[id]'],
		[`/calendar/events/${crypto.randomUUID()}?/reminderRemove`, '/(app)/calendar/events/[id]'],
		[`/calendar/events/${crypto.randomUUID()}/edit?/update`, '/(app)/calendar/events/[id]/edit'],
		['/reminders?/create', '/(app)/reminders'],
		['/reminders?/remove', '/(app)/reminders'],
		['/account?/emailReminders', '/(app)/account'],
		['/projects/OPS/tasks/1?/reminderAdd', '/(app)/projects/[key]/tasks/[number]'],
		['/projects/OPS/tasks/1?/reminderRemove', '/(app)/projects/[key]/tasks/[number]']
	];

	it('a cross-site or Origin-less form POST is refused before any route code', async () => {
		vi.useRealTimers();
		const token = await insertSession(db, ana.id);
		for (const [path, routeId] of ACTIONS)
			for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }]) {
				const { response, resolved } = await hook({
					url: `http://localhost${path}`,
					routeId,
					db,
					form: { id: 'x', on: '1' },
					headers,
					cookies: { [sessionCookieName(false)]: token }
				});
				expect(response.status, path).toBe(403);
				expect(resolved).toBe(0);
			}
	});

	it('signed-in RB-09 pages are private, no-store; a deactivated user is stopped at the gate', async () => {
		vi.useRealTimers();
		const token = await insertSession(db, ana.id);
		const off = await insertUser(db, { status: 'disabled' });
		const offToken = await insertSession(db, off.id);
		for (const [path, routeId] of [
			['/calendar', '/(app)/calendar'],
			['/calendar/events/x', '/(app)/calendar/events/[id]'],
			['/reminders', '/(app)/reminders'],
			['/calendar/__data.json', '/(app)/calendar']
		]) {
			const ok = await hook({
				url: `http://localhost${path}`,
				routeId,
				db,
				cookies: { [sessionCookieName(false)]: token }
			});
			expect(ok.resolved).toBe(1);
			expect(ok.response.headers.get('cache-control')).toBe('private, no-store');
			const gone = await hook({
				url: `http://localhost${path}`,
				routeId,
				db,
				cookies: { [sessionCookieName(false)]: offToken }
			});
			expect(gone.resolved, path).toBe(0);
			expect([303, 401]).toContain(gone.response.status);
		}
	});

	it('the e-mail toggle is 404 while no sender is configured, and only ever changes the caller', async () => {
		expect(
			status(await call(account.actions.emailReminders, ev('/account', ana, { form: { on: '1' } })))
		).toBe(404);
		binding.REMINDER_EMAIL_FROM = 'ruby@example.test';
		try {
			await call(
				account.actions.emailReminders,
				ev('/account', ana, { form: { on: '1', user_id: bo.id, userId: bo.id } })
			);
			const { results } = await d1
				.prepare(`SELECT user_id AS u, email_reminders AS on_ FROM user_calendar_prefs`)
				.all<{ u: string; on_: number }>();
			expect(results).toEqual([{ u: ana.id, on_: 1 }]);
			const page = await call(account.load, ev('/account', bo));
			expect(page).toMatchObject({ emailReminders: { on: false } });
		} finally {
			binding.REMINDER_EMAIL_FROM = '';
		}
	});
});
