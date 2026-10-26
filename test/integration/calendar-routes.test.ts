import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { loadCalendar } from '#lib/server/calendar/repo';
import { getDb, type Db } from '#lib/server/db';
import { createMilestone, deleteMilestone } from '#lib/server/pm/milestones';
import { createReminder } from '#lib/server/reminders/repo';
import { CAL_LIMITS, parseCalendarFilter, type CalendarFilter } from '#lib/shared/calendar';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { at, clearCalendar, JKT, reminderRow, seedEvent } from '../helpers/seed-calendar';
import { archive, seedProject, seedTask } from '../helpers/seed-tasks';
import { insertUser } from '../helpers/users';

/**
 * RB-09 routes end to end against local D1: /calendar, events (create, detail, edit, delete), the reminder panels and
 * /reminders, with members, admins and private events (PRD › Authorization per action, acceptance 1–4, 8, 10–18).
 */

vi.mock('#lib/server/env', () => ({
	getEnv: () => ({ TEAM_TIME_ZONE: 'Asia/Jakarta', REMINDER_EMAIL_FROM: '' })
}));

const calendar = await import('../../src/routes/(app)/calendar/+page.server');
const newEvent = await import('../../src/routes/(app)/calendar/events/new/+page.server');
const detail = await import('../../src/routes/(app)/calendar/events/[id]/+page.server');
const edit = await import('../../src/routes/(app)/calendar/events/[id]/edit/+page.server');
const remindersPage = await import('../../src/routes/(app)/reminders/+page.server');
const taskPage = await import('../../src/routes/(app)/projects/[key]/tasks/[number]/+page.server');

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
const data = <T = Record<string, unknown>>(x: unknown) => (isActionFailure(x) ? x.data : x) as T;

const ev = (
	path: string,
	user: SessionUser | null,
	options: {
		form?: Record<string, string> | [string, string][];
		params?: Record<string, string>;
	} = {}
) => fakeEvent({ url: `http://localhost${path}`, db, user: user ?? undefined, ...options }).event;

const loadCal = async (user: SessionUser, query = '') =>
	data<{
		items: { kind: string; title: string; key: string; private: boolean }[];
		capped: boolean;
	}>(await call(calendar.load, ev(`/calendar?${query}`, user)));

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
	admin = await insertUser(db, { role: 'admin', name: 'Ada Admin' });
	ana = await insertUser(db, { name: 'Ana Member' });
	bo = await insertUser(db, { name: 'Bo Member' });
	cy = await insertUser(db, { name: 'Cy Member' });
});

const eventForm = (extra: Record<string, string> = {}): Record<string, string> => ({
	title: 'Design review',
	startDate: '2026-11-02',
	startTime: '14:00',
	endDate: '2026-11-02',
	endTime: '15:30',
	visibility: 'team',
	...extra
});

describe('access (1, 2)', () => {
	it('signed out: every load and action answers 401', async () => {
		const id = await seedEvent(db, ana);
		const params = { id };
		const cases: [unknown, string, Record<string, string> | undefined][] = [
			[calendar.load, '/calendar', undefined],
			[newEvent.load, '/calendar/events/new', undefined],
			[newEvent.actions.create, '/calendar/events/new', eventForm()],
			[detail.load, `/calendar/events/${id}`, undefined],
			[detail.actions.remove, `/calendar/events/${id}`, { confirm: 'yes' }],
			[detail.actions.removeOccurrence, `/calendar/events/${id}`, { on: '2026-11-02' }],
			[detail.actions.reminderAdd, `/calendar/events/${id}`, { offset: '10' }],
			[detail.actions.reminderRemove, `/calendar/events/${id}`, { id }],
			[edit.load, `/calendar/events/${id}/edit`, undefined],
			[edit.actions.update, `/calendar/events/${id}/edit`, eventForm()],
			[remindersPage.load, '/reminders', undefined],
			[
				remindersPage.actions.create,
				'/reminders',
				{ title: 'x', date: '2026-11-02', time: '09:00' }
			],
			[remindersPage.actions.remove, '/reminders', { id }]
		];
		for (const [fn, path, form] of cases)
			expect(status(await call(fn, ev(path, null, { form, params }))), path).toBe(401);
	});

	it('a private event: hidden and missing ids look the same to a third member and to an admin (14)', async () => {
		const priv = await seedEvent(db, ana, {
			visibility: 'private',
			attendeeIds: [bo.id],
			title: 'Secret 1:1'
		});
		const missing = crypto.randomUUID();
		for (const viewer of [cy, admin]) {
			const hidden = await call(
				detail.load,
				ev(`/calendar/events/${priv}`, viewer, { params: { id: priv } })
			);
			const none = await call(
				detail.load,
				ev(`/calendar/events/${missing}`, viewer, { params: { id: missing } })
			);
			expect(status(hidden)).toBe(404);
			expect(status(none)).toBe(404);
			expect((hidden as { body: unknown }).body).toEqual((none as { body: unknown }).body);
			for (const action of ['remove', 'reminderAdd'] as const)
				expect(
					status(
						await call(
							detail.actions[action],
							ev(`/calendar/events/${priv}`, viewer, {
								params: { id: priv },
								form: { confirm: 'yes', offset: '10' }
							})
						)
					)
				).toBe(404);
			expect(
				status(
					await call(
						edit.load,
						ev(`/calendar/events/${priv}/edit`, viewer, { params: { id: priv } })
					)
				)
			).toBe(404);
			const cal = await loadCal(viewer, 'date=2026-11-02&view=month');
			expect(cal.items.some((i) => i.title === 'Secret 1:1')).toBe(false);
		}
		for (const viewer of [ana, bo]) {
			expect(
				status(
					await call(detail.load, ev(`/calendar/events/${priv}`, viewer, { params: { id: priv } }))
				)
			).toBe(200);
			const cal = await loadCal(viewer, 'date=2026-11-02&view=month');
			expect(cal.items.find((i) => i.title === 'Secret 1:1')?.private).toBe(true);
		}
		const team = await seedEvent(db, ana, { title: 'Town hall' });
		expect(
			status(await call(detail.load, ev(`/calendar/events/${team}`, cy, { params: { id: team } })))
		).toBe(200);
	});
});

describe('calendar (4, 7, 8)', () => {
	it('tasks: mine, all, a project; deleted, archived and closed rules', async () => {
		const ops = await seedProject(db, ana, { key: 'OPS' });
		const web = await seedProject(db, ana, { key: 'WEB' });
		const old = await seedProject(db, ana, { key: 'OLD' });
		await seedTask(db, ana, ops, { title: 'Today', dueOn: '2026-11-02', assigneeId: ana.id });
		await seedTask(db, ana, ops, { title: 'In five', dueOn: '2026-11-07', assigneeId: ana.id });
		await seedTask(db, ana, ops, { title: 'Next month', dueOn: '2026-12-20', assigneeId: ana.id });
		await seedTask(db, ana, web, { title: 'Bo web', dueOn: '2026-11-03', assigneeId: bo.id });
		await seedTask(db, ana, ops, {
			title: 'Done',
			dueOn: '2026-11-04',
			assigneeId: ana.id,
			status: 'done'
		});
		const gone = await seedTask(db, ana, ops, {
			title: 'Deleted',
			dueOn: '2026-11-04',
			assigneeId: ana.id
		});
		await d1.prepare(`UPDATE tasks SET deleted_at = 1 WHERE id = ?1`).bind(gone.id).run();
		await seedTask(db, ana, old, { title: 'Archived', dueOn: '2026-11-04', assigneeId: ana.id });
		await archive(db, old.id);
		const titles = async (q: string, user = ana) =>
			(await loadCal(user, `view=month&date=2026-11-10&${q}`)).items
				.map((i) => i.title.replace(/^\w+-\d+ /, ''))
				.sort();
		expect(await titles('')).toEqual(['In five', 'Today']);
		expect(await titles('tasks=all')).toEqual(['Bo web', 'In five', 'Today']);
		expect(await titles('tasks=project&project=WEB')).toEqual(['Bo web']);
		expect(await titles('tasks=all&project=OPS')).toEqual(['In five', 'Today']);
		expect(await titles('done=1')).toEqual(['Done', 'In five', 'Today']);
		expect(await titles('', bo)).toEqual(['Bo web']);
		expect(await titles('show=events')).toEqual([]);
		expect(
			(await loadCal(ana, 'view=agenda&date=2026-12-15')).items.map((i) =>
				i.title.replace(/^\w+-\d+ /, '')
			)
		).toEqual(['Next month']);
	});

	it('milestones (5): open ones in range link to their page; closed only with done=1; deleted, archived and deleted-project ones never', async () => {
		const ops = await seedProject(db, ana, { key: 'MOPS' });
		const old = await seedProject(db, ana, { key: 'MOLD' });
		const gone = await seedProject(db, ana, { key: 'MGON' });
		const mk = async (projectId: string, name: string, dueOn: string | null) => {
			const r = await createMilestone(
				db,
				ana,
				projectId,
				{ name, description: '', dueOn },
				Date.now()
			);
			if (!r.ok) throw new Error(`createMilestone: ${r.reason}`);
			return r.id;
		};
		const open = await mk(ops.id, 'Beta', '2026-11-12');
		await mk(ops.id, 'Next year', '2027-03-01');
		await mk(ops.id, 'No date', null);
		const closed = await mk(ops.id, 'Alpha', '2026-11-05');
		await d1
			.prepare(`UPDATE milestones SET status = 'closed', closed_at = 1 WHERE id = ?1`)
			.bind(closed)
			.run();
		const deleted = await mk(ops.id, 'Dropped', '2026-11-06');
		expect((await deleteMilestone(db, ana, ops.id, deleted, Date.now())).ok).toBe(true);
		await mk(old.id, 'Archived project', '2026-11-07');
		await archive(db, old.id);
		await mk(gone.id, 'Deleted project', '2026-11-08');
		await d1.prepare(`UPDATE projects SET deleted_at = 1 WHERE id = ?1`).bind(gone.id).run();
		await seedProject(db, ana, { key: 'MWEB' });

		const items = async (q: string) =>
			(await loadCal(ana, `view=month&date=2026-11-10&show=milestones&${q}`)).items as unknown as {
				kind: string;
				title: string;
				href: string;
				done: boolean;
			}[];
		expect(await items('')).toEqual([
			expect.objectContaining({
				kind: 'milestone',
				title: 'MOPS · Beta',
				href: `/projects/MOPS/milestones/${open}`,
				done: false
			})
		]);
		expect((await items('done=1')).map((i) => [i.title, i.done])).toEqual([
			['MOPS · Alpha', true],
			['MOPS · Beta', false]
		]);
		expect(await items('project=MWEB')).toEqual([]);
		expect((await items('project=MOPS')).map((i) => i.title)).toEqual(['MOPS · Beta']);
		expect(
			(await loadCal(ana, 'view=month&date=2026-11-10&show=tasks')).items.filter(
				(i) => i.kind === 'milestone'
			)
		).toEqual([]);
	});

	it('time off (6): approved leave as names and day parts on work days, holidays by name; nothing else (payload scan)', async () => {
		const type = await d1
			.prepare(`SELECT id FROM leave_types ORDER BY sort LIMIT 1`)
			.first<{ id: string }>();
		const emp = async (name: string) => {
			const id = crypto.randomUUID();
			await d1
				.prepare(
					`INSERT INTO employees (id, full_name, employment_type, status, created_by, created_at, updated_at)
					 VALUES (?1, ?2, 'permanent', 'active', ?3, 1, 1)`
				)
				.bind(id, name, admin.id)
				.run();
			return id;
		};
		const leave = (
			employee: string,
			startOn: string,
			endOn: string,
			status: string,
			halfDay = 'none'
		) =>
			d1
				.prepare(
					`INSERT INTO leave_requests (id, employee_id, type_id, start_on, end_on, half_day, half_days, period, reason,
						status, created_by, created_at, updated_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 2, 2026, 'Secret reason text', ?7, ?8, 1, 1)`
				)
				.bind(crypto.randomUUID(), employee, type!.id, startOn, endOn, halfDay, status, admin.id)
				.run();
		const rina = await emp('Rina Fictional');
		const dodi = await emp('Dodi Fictional');
		const gone = await emp('Gone Fictional');
		await d1.prepare(`UPDATE employees SET deleted_at = 1 WHERE id = ?1`).bind(gone).run();
		await leave(rina, '2026-11-05', '2026-11-09', 'approved'); // Thu..Mon: the weekend is skipped
		await leave(dodi, '2026-11-03', '2026-11-03', 'approved', 'pm');
		await leave(dodi, '2026-11-10', '2026-11-10', 'pending');
		await leave(dodi, '2026-11-11', '2026-11-11', 'rejected');
		await leave(dodi, '2026-11-12', '2026-11-12', 'canceled');
		await leave(gone, '2026-11-04', '2026-11-04', 'approved');
		await d1
			.prepare(
				`INSERT INTO holidays (id, on_date, name, deducts_leave, created_by, created_at, updated_at)
				 VALUES (?1, '2026-11-06', 'Fictional Day', 0, ?2, 1, 1)`
			)
			.bind(crypto.randomUUID(), admin.id)
			.run();
		const page = await call(
			calendar.load,
			ev('/calendar?view=month&date=2026-11-10&show=timeoff', bo)
		);
		const items = data<{
			items: { kind: string; title: string; startOn: string; href: string | null }[];
		}>(page).items;
		expect(items.every((i) => i.kind === 'timeoff' && i.href === null)).toBe(true);
		expect(items.map((i) => `${i.startOn} ${i.title}`).sort()).toEqual([
			'2026-11-03 Dodi Fictional (out pm)',
			'2026-11-05 Rina Fictional (out)',
			'2026-11-06 Fictional Day',
			'2026-11-09 Rina Fictional (out)'
		]);
		const payload = JSON.stringify(page);
		for (const leak of [
			'Secret reason text',
			'pending',
			'rejected',
			'Gone Fictional',
			type!.id,
			'Annual',
			'Sick'
		])
			expect(payload).not.toContain(leak);
	});

	it('an all-day event over 3 days; invalid parameters fall back; the month block and the agenda in one load', async () => {
		await seedEvent(db, ana, {
			allDay: true,
			startOn: '2026-11-02',
			endOn: '2026-11-04',
			startAt: null,
			endAt: null,
			title: 'Offsite'
		});
		const page = data<{
			filter: CalendarFilter;
			ranges: { grid: unknown; agenda: unknown; window: { from: string; to: string } };
		}>(
			await call(
				calendar.load,
				ev('/calendar?view=bogus&date=2026-13-45&show=nope&project=lower-case', ana)
			)
		);
		expect(page.filter.view).toBeNull();
		expect(page.ranges.grid).not.toBeNull();
		expect(page.ranges.agenda).not.toBeNull();
		const cal = await loadCal(ana, 'view=week&date=2026-11-03');
		expect(cal.items.filter((i) => i.title === 'Offsite')).toHaveLength(1);
	});

	it('caps: 500 per source, "not all shown", and a constant number of queries (8)', async () => {
		const ops = await seedProject(db, ana, { key: 'CAP' });
		const bulk = (n: number, from: number) =>
			d1
				.prepare(
					`WITH RECURSIVE k(i) AS (SELECT ?2 UNION ALL SELECT i + 1 FROM k WHERE i < ?2 + ?3 - 1)
					 INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, due_on, position, created_by, created_at, updated_at)
					 SELECT lower(hex(randomblob(16))), ?1, 1000 + i, 'Bulk ' || i, 'todo', 'none', ?4, '2026-11-1' || (i % 9), i, ?4, 1, 1 FROM k`
				)
				.bind(ops.id, from, n, ana.id)
				.run();
		let prepared = 0;
		const counting = new Proxy(d1, {
			get(target, prop) {
				if (prop === 'prepare')
					return (q: string) => {
						prepared += 1;
						return target.prepare(q);
					};
				const value = Reflect.get(target, prop);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const countingDb = getDb(counting);
		const filter = parseCalendarFilter(
			new URLSearchParams('view=month&date=2026-11-10'),
			'2026-11-10',
			['tasks', 'events']
		);
		await seedEvent(db, ana, { recFreq: 'daily', recUntilOn: '2026-11-30' });
		const measure = async () => {
			prepared = 0;
			const r = await loadCalendar(
				countingDb,
				ana.id,
				filter,
				{ from: '2026-10-26', to: '2026-12-06' },
				{ projectId: null, today: '2026-11-10', zone: JKT }
			);
			return { queries: prepared, items: r.items.length, capped: r.capped };
		};
		await bulk(10, 1);
		const small = await measure();
		await bulk(1190, 11);
		const big = await measure();
		expect(small.capped).toBe(false);
		expect(big.capped).toBe(true);
		expect(big.items).toBeLessThanOrEqual(CAL_LIMITS.mergedMax);
		expect(big.items).toBe(CAL_LIMITS.sourceMax + 29); // 500 tasks + 29 daily occurrences of the series
		expect(big.queries).toBe(small.queries);
	});
});

describe('events (10, 11, 15, 16)', () => {
	it('create: 14:00–15:30 WIB is stored as 07:00Z; refusals keep the form', async () => {
		const r = await call(
			newEvent.actions.create,
			ev('/calendar/events/new', ana, { form: eventForm() })
		);
		expect(status(r)).toBe(303);
		const row = await d1.prepare(`SELECT * FROM events`).first<Record<string, unknown>>();
		expect(new Date(row?.start_at as number).toISOString()).toBe('2026-11-02T07:00:00.000Z');
		expect(row).toMatchObject({
			first_on: '2026-11-02',
			last_on: '2026-11-02',
			created_by: ana.id
		});
		expect(isRedirect(r) && r.location).toBe(`/calendar/events/${row?.id}?created=1`);

		const bad = await call(
			newEvent.actions.create,
			ev('/calendar/events/new', ana, { form: eventForm({ title: '', endTime: '13:00' }) })
		);
		expect(status(bad)).toBe(400);
		expect(data<{ errors: Record<string, string> }>(bad).errors).toMatchObject({
			title: expect.any(String),
			end: expect.any(String)
		});

		const old = await seedProject(db, ana, { key: 'ARC' });
		await archive(db, old.id);
		const archived = await call(
			newEvent.actions.create,
			ev('/calendar/events/new', ana, { form: eventForm({ projectId: old.id }) })
		);
		expect(data<{ errors: Record<string, string> }>(archived).errors.projectId).toBeTruthy();
		await d1.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?1`).bind(cy.id).run();
		const inactive = await call(
			newEvent.actions.create,
			ev('/calendar/events/new', ana, {
				form: [...Object.entries(eventForm()), ['attendees', cy.id]]
			})
		);
		expect(data<{ errors: Record<string, string> }>(inactive).errors.attendees).toBeTruthy();
		expect((await d1.prepare(`SELECT count(*) AS n FROM events`).first<{ n: number }>())?.n).toBe(
			1
		);
	});

	it('the 501st live event of one user and the 101st of one user in a day are refused; others are not affected', async () => {
		await d1
			.prepare(
				`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 500)
				 INSERT INTO events (id, title, all_day, start_on, end_on, first_on, last_on, created_by, created_at, updated_at)
				 SELECT lower(hex(randomblob(16))), 'E' || i, 1, '2026-11-02', '2026-11-02', '2026-11-02', '2026-11-02', ?1, 1, 1 FROM k`
			)
			.bind(bo.id)
			.run();
		const r = await call(
			newEvent.actions.create,
			ev('/calendar/events/new', bo, { form: eventForm() })
		);
		expect(status(r)).toBe(409);
		expect(
			status(
				await call(newEvent.actions.create, ev('/calendar/events/new', ana, { form: eventForm() }))
			)
		).toBe(303);
		await d1.prepare(`UPDATE events SET deleted_at = 1`).run();
		await d1
			.prepare(
				`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 100)
				 INSERT INTO events (id, title, all_day, start_on, end_on, first_on, last_on, created_by, created_at, updated_at)
				 SELECT lower(hex(randomblob(16))), 'E' || i, 1, '2026-11-02', '2026-11-02', '2026-11-02', '2026-11-02', ?1, ?2, ?2 FROM k`
			)
			.bind(ana.id, Date.now())
			.run();
		expect(
			status(
				await call(newEvent.actions.create, ev('/calendar/events/new', ana, { form: eventForm() }))
			)
		).toBe(429);
		expect(
			status(
				await call(newEvent.actions.create, ev('/calendar/events/new', bo, { form: eventForm() }))
			)
		).toBe(303);
	});

	it('edit: creator and admin may, another member gets 403; a stale version gets 409 and nothing is overwritten', async () => {
		const id = await seedEvent(db, ana, { title: 'Original', attendeeIds: [bo.id] });
		const params = { id };
		const version = async () =>
			(await d1
				.prepare(`SELECT updated_at AS u FROM events WHERE id = ?1`)
				.bind(id)
				.first<{ u: number }>())!.u;
		expect(status(await call(edit.load, ev(`/calendar/events/${id}/edit`, bo, { params })))).toBe(
			403
		);
		expect(
			status(
				await call(
					edit.actions.update,
					ev(`/calendar/events/${id}/edit`, bo, {
						params,
						form: { ...eventForm(), expectedUpdatedAt: String(await version()) }
					})
				)
			)
		).toBe(403);
		const v1 = await version();
		const first = await call(
			edit.actions.update,
			ev(`/calendar/events/${id}/edit`, ana, {
				params,
				form: [
					...Object.entries(eventForm({ title: 'Mine', expectedUpdatedAt: String(v1) })),
					['attendees', cy.id]
				]
			})
		);
		expect(status(first)).toBe(303);
		const stale = await call(
			edit.actions.update,
			ev(`/calendar/events/${id}/edit`, admin, {
				params,
				form: { ...eventForm({ title: 'Theirs' }), expectedUpdatedAt: String(v1) }
			})
		);
		expect(status(stale)).toBe(409);
		expect(data<{ values: { title: string } }>(stale).values.title).toBe('Theirs');
		const row = await d1
			.prepare(`SELECT title FROM events WHERE id = ?1`)
			.bind(id)
			.first<{ title: string }>();
		expect(row?.title).toBe('Mine');
		const att = await d1
			.prepare(`SELECT user_id AS u FROM event_attendees WHERE event_id = ?1`)
			.bind(id)
			.all<{ u: string }>();
		expect(att.results.map((a) => a.u)).toEqual([cy.id]);
		expect(
			status(
				await call(
					edit.actions.update,
					ev(`/calendar/events/${id}/edit`, admin, {
						params,
						form: { ...eventForm({ title: 'Admin' }), expectedUpdatedAt: String(await version()) }
					})
				)
			)
		).toBe(303);
	});

	it('delete: occurrence then series; a deleted event answers 404 and leaves the calendar', async () => {
		const id = await seedEvent(db, ana, {
			title: 'Weekly',
			recFreq: 'weekly',
			recUntilOn: '2026-11-23'
		});
		const params = { id };
		expect(
			status(
				await call(
					detail.actions.remove,
					ev(`/calendar/events/${id}`, bo, { params, form: { confirm: 'yes' } })
				)
			)
		).toBe(403);
		expect(
			status(
				await call(
					detail.actions.removeOccurrence,
					ev(`/calendar/events/${id}`, ana, { params, form: { on: '2026-11-10' } })
				)
			)
		).toBe(400);
		expect(
			status(
				await call(
					detail.actions.removeOccurrence,
					ev(`/calendar/events/${id}`, ana, { params, form: { on: '2026-11-09' } })
				)
			)
		).toBe(303);
		const weekly = async () =>
			(await loadCal(ana, 'view=month&date=2026-11-10')).items
				.filter((i) => i.title === 'Weekly')
				.map((i) => i.key.slice(-10));
		expect(await weekly()).toEqual(['2026-11-02', '2026-11-16', '2026-11-23']);
		expect(
			status(
				await call(detail.actions.remove, ev(`/calendar/events/${id}`, ana, { params, form: {} }))
			)
		).toBe(400);
		expect(
			status(
				await call(
					detail.actions.remove,
					ev(`/calendar/events/${id}`, admin, { params, form: { confirm: 'yes' } })
				)
			)
		).toBe(303);
		expect(await weekly()).toEqual([]);
		expect(status(await call(detail.load, ev(`/calendar/events/${id}`, ana, { params })))).toBe(
			404
		);
	});
});

describe('reminders (17, 18)', () => {
	const taskAction = (
		user: SessionUser,
		key: string,
		number: number,
		action: 'reminderAdd' | 'reminderRemove',
		form: Record<string, string>
	) =>
		call(
			taskPage.actions[action],
			ev(`/projects/${key}/tasks/${number}`, user, {
				params: { key, number: String(number) },
				form
			})
		);

	it('task presets, absolute times and their refusals; a second identical create keeps one row', async () => {
		const p = await seedProject(db, ana, { key: 'REM' });
		const due = await seedTask(db, ana, p, { dueOn: '2026-11-05' });
		const noDue = await seedTask(db, ana, p, {});
		vi.useFakeTimers({ now: at('2026-11-01', '12:00'), toFake: ['Date'] });
		try {
			expect(
				data(await taskAction(ana, 'REM', due.number, 'reminderAdd', { offset: '1440' }))
			).toEqual({ reminder: { added: true } });
			expect(
				data(await taskAction(ana, 'REM', due.number, 'reminderAdd', { offset: '1440' }))
			).toEqual({ reminder: { added: true } });
			const rows = await d1.prepare(`SELECT fire_at FROM reminders`).all<{ fire_at: number }>();
			expect(rows.results.map((r) => new Date(r.fire_at).toISOString())).toEqual([
				'2026-11-04T02:00:00.000Z'
			]);
			expect(status(await taskAction(ana, 'REM', due.number, 'reminderAdd', { offset: '7' }))).toBe(
				400
			);
			expect(
				status(await taskAction(ana, 'REM', noDue.number, 'reminderAdd', { offset: '0' }))
			).toBe(400);
			expect(
				status(
					await taskAction(ana, 'REM', due.number, 'reminderAdd', {
						mode: 'absolute',
						date: '2026-11-01',
						time: '12:00'
					})
				)
			).toBe(400);
			expect(
				status(
					await taskAction(ana, 'REM', due.number, 'reminderAdd', {
						mode: 'absolute',
						date: '2029-01-01',
						time: '12:00'
					})
				)
			).toBe(400);
			expect(
				status(
					await taskAction(ana, 'REM', noDue.number, 'reminderAdd', {
						mode: 'absolute',
						date: '2026-11-03',
						time: '10:30'
					})
				)
			).toBe(200);
		} finally {
			vi.useRealTimers();
		}
	});

	it('event reminders: "10 minutes" before; a private event the user cannot see is 404', async () => {
		// Minute precision, as the form gives.
		const start = Math.ceil((Date.now() + 2 * 86_400_000) / 60_000) * 60_000;
		const id = await seedEvent(db, ana, { startAt: start, endAt: start + 3_600_000 });
		const priv = await seedEvent(db, ana, {
			visibility: 'private',
			startAt: start,
			endAt: start + 3_600_000
		});
		const r = await call(
			detail.actions.reminderAdd,
			ev(`/calendar/events/${id}`, bo, { params: { id }, form: { offset: '10' } })
		);
		expect(data(r)).toEqual({ reminder: { added: true } });
		const row = await d1
			.prepare(`SELECT fire_at, user_id FROM reminders`)
			.first<{ fire_at: number; user_id: string }>();
		expect(row).toEqual({ fire_at: start - 10 * 60_000, user_id: bo.id });
		expect(
			status(
				await call(
					detail.actions.reminderAdd,
					ev(`/calendar/events/${priv}`, bo, { params: { id: priv }, form: { offset: '10' } })
				)
			)
		).toBe(404);
		expect(
			(
				await createReminder(
					db,
					bo.id,
					{ kind: 'event', eventId: priv, offset: 10 },
					Date.now(),
					JKT
				)
			).ok
		).toBe(false);
	});

	it('limits hold under concurrency: 10 per target, 200 pending per user', async () => {
		const p = await seedProject(db, ana, { key: 'LIM' });
		const t = await seedTask(db, ana, p, { dueOn: '2027-01-10' });
		const now = Date.now();
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				createReminder(
					db,
					ana.id,
					{ kind: 'task', taskId: t.id, mode: 'absolute', remindAt: now + 3_600_000 + i * 60_000 },
					now,
					JKT
				)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(10);
		expect(results.filter((r) => !r.ok && r.reason === 'target_limit')).toHaveLength(10);
		await d1
			.prepare(
				`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 190)
				 INSERT INTO reminders (id, user_id, target_kind, target_id, mode, remind_at, title, fire_at, created_at, updated_at)
				 SELECT lower(hex(randomblob(16))), ?1, 'personal', NULL, 'absolute', ?2 + i, 'P' || i, ?2 + i, 1, 1 FROM k`
			)
			.bind(ana.id, now + 3_600_000)
			.run();
		const over = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				createReminder(
					db,
					ana.id,
					{ kind: 'personal', title: `Extra ${i}`, remindAt: now + 7_200_000 },
					now,
					JKT
				)
			)
		);
		expect(over.every((r) => !r.ok && r.reason === 'user_limit')).toBe(true);
	});

	it('ownership: nobody else can list or delete a reminder, admin included', async () => {
		const made = await createReminder(
			db,
			ana.id,
			{ kind: 'personal', title: 'Private note', remindAt: Date.now() + 3_600_000 },
			Date.now(),
			JKT
		);
		if (!made.ok) throw new Error('setup');
		for (const other of [bo, admin]) {
			expect(
				status(
					await call(
						remindersPage.actions.remove,
						ev('/reminders', other, { form: { id: made.id } })
					)
				)
			).toBe(404);
			const page = data<{ pending: unknown[]; history: unknown[] }>(
				await call(remindersPage.load, ev('/reminders', other))
			);
			expect(page.pending).toEqual([]);
		}
		expect(await reminderRow(db, made.id)).toMatchObject({ deleted_at: null });
		const mine = data<{ pending: { id: string; title: string }[]; schedulerLate: number | null }>(
			await call(remindersPage.load, ev('/reminders', ana))
		);
		expect(mine.pending.map((r) => r.title)).toEqual(['Private note']);
		expect(mine.schedulerLate).toBeNull();
		expect(
			data(
				await call(remindersPage.actions.remove, ev('/reminders', ana, { form: { id: made.id } }))
			)
		).toEqual({ removed: true });
	});

	it('/reminders create: a personal reminder; past and empty refused', async () => {
		vi.useFakeTimers({ now: at('2026-11-01', '12:00'), toFake: ['Date'] });
		try {
			expect(
				data(
					await call(
						remindersPage.actions.create,
						ev('/reminders', ana, {
							form: { title: 'Pay invoice', date: '2026-11-02', time: '09:00' }
						})
					)
				)
			).toEqual({ created: true });
			const row = await d1.prepare(`SELECT title, fire_at, target_id FROM reminders`).first();
			expect(row).toEqual({
				title: 'Pay invoice',
				fire_at: at('2026-11-02', '09:00'),
				target_id: null
			});
			expect(
				status(
					await call(
						remindersPage.actions.create,
						ev('/reminders', ana, { form: { title: '', date: '2026-11-02', time: '09:00' } })
					)
				)
			).toBe(400);
			expect(
				status(
					await call(
						remindersPage.actions.create,
						ev('/reminders', ana, { form: { title: 'Late', date: '2026-11-01', time: '11:00' } })
					)
				)
			).toBe(400);
		} finally {
			vi.useRealTimers();
		}
	});
});
