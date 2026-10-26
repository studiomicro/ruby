import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { loadViewer } from '#lib/server/hr/access';
import { getEmployee, softDelete, terminate } from '#lib/server/hr/repo';
import { addDays, isoWeekday, yearOf } from '#lib/server/timeoff/calendar';
import { balancesFor, decide } from '#lib/server/timeoff/repo';
import { teamToday } from '#lib/server/tasks/today';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { auditRows, seedEmployee } from '../helpers/seed-hr';
import {
	leaveWorld,
	ledgerRows,
	planBase,
	rangesOf,
	requestAs,
	requestRow
} from '../helpers/seed-leave';
import { insertSession, insertUser } from '../helpers/users';

/**
 * RB-06 red team, cycle 1: loads and actions against local D1. Findings:
 * docs/features/rb-06-time-off/SECURITY_REPORT.md. "FIXED" tests were cycle 1's PROOF tests, flipped in cycle 2
 * to assert the fix; the others prove a control that held.
 */

const binding: {
	DB?: D1Database;
	TEAM_TIME_ZONE: string;
	ACCESS_TEAM_DOMAIN: string;
	ACCESS_AUD: string;
} = { TEAM_TIME_ZONE: 'Asia/Jakarta', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' };
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const mine = await import('../../src/routes/(app)/time-off/+page.server');
const calendar = await import('../../src/routes/(app)/time-off/calendar/+page.server');
const approvals = await import('../../src/routes/(app)/time-off/approvals/+page.server');
const team = await import('../../src/routes/(app)/time-off/team/+page.server');
const settings = await import('../../src/routes/(app)/time-off/settings/+page.server');
const appLayout = await import('../../src/routes/(app)/+layout.server');
const hrAudit = await import('../../src/routes/(app)/hr/audit/+page.server');
const { handle } = await import('../../src/hooks.server');

let db: Db;
let raw: D1Database;
let dispose: () => Promise<void>;
let today: string;
let base: string;
beforeAll(async () => {
	const opened = await openLocalD1();
	binding.DB = opened.db;
	raw = opened.db;
	db = getDb(opened.db);
	dispose = opened.dispose;
	today = teamToday();
	base = planBase(today);
});
afterAll(() => dispose());

type Fn = (event: never) => unknown;
async function run(fn: unknown, event: unknown): Promise<unknown> {
	try {
		return await (fn as Fn)(event as never);
	} catch (e) {
		return e;
	}
}
const status = (r: unknown) =>
	isHttpError(r)
		? r.status
		: isRedirect(r)
			? r.status
			: ((r as { status?: number })?.status ?? 200);
const dataOf = (r: unknown) =>
	((r as { data?: Record<string, unknown> }).data ?? r) as Record<string, unknown>;
const req = (
	user: SessionUser | null,
	path: string,
	form?: Record<string, string> | [string, string][]
) => fakeEvent({ url: `http://localhost${path}`, db, user, form }).event;

const expectedOf = async (id: string) => String((await requestRow(db, id))!.updatedAt);
const approveAs = async (user: SessionUser, id: string, expected?: string) =>
	run(
		approvals.actions.approve,
		req(user, '/time-off/approvals?/approve', { id, expected: expected ?? (await expectedOf(id)) })
	);
const cancelOwn = async (user: SessionUser, id: string, expected?: string) =>
	run(
		mine.actions.cancel,
		req(user, '/time-off?/cancel', { id, expected: expected ?? (await expectedOf(id)) })
	);
const ledgerSum = async (employeeId: string, period: number) =>
	(await ledgerRows(db, employeeId))
		.filter((r) => r.period === period)
		.reduce((n, r) => n + r.halfDays, 0);

/** A pending annual request of the report (manager: managerUser). */
async function pendingOf(w: Awaited<ReturnType<typeof leaveWorld>>, offset = 0, halfDays = 2) {
	const [range] = rangesOf(addDays(base, offset), halfDays, 1);
	const made = await requestAs(db, w.users.reportUser, range!);
	if (!made.ok) throw new Error(`request failed: ${made.reason}`);
	return made.id;
}

/** The latest past working day within the 30-day window (for "already started" leave). */
function pastWorkDay(): string {
	for (let i = 1; i < 29; i += 1) {
		const d = addDays(today, -i);
		if (isoWeekday(d) <= 5) return d;
	}
	throw new Error('no past work day');
}

describe('approval authorization', () => {
	it('requester, peer, skip-level, outsider and a non-fallback admin get 404; nothing changes', async () => {
		const w = await leaveWorld(db);
		const peerUser = await insertUser(db, { name: `Peer ${w.tag}` });
		await seedEmployee(
			db,
			w.users.hr.id,
			{ fullName: `Peer Person ${w.tag}`, managerId: w.employees.manager, startOn: '2024-01-01' },
			peerUser.id
		);
		const id = await pendingOf(w);
		for (const user of [
			w.users.reportUser,
			peerUser,
			w.users.topUser,
			w.users.outsider,
			w.users.admin
		]) {
			expect(status(await approveAs(user, id))).toBe(404);
			expect(
				status(
					await run(
						approvals.actions.reject,
						req(user, '/time-off/approvals?/reject', { id, expected: await expectedOf(id) })
					)
				)
			).toBe(404);
		}
		expect((await requestRow(db, id))!.status).toBe('pending');
		expect((await ledgerRows(db, w.employees.report)).some((r) => r.kind === 'usage')).toBe(false);
	});

	it('a disabled manager account cannot decide, even with a session that survived; HR takes over', async () => {
		const w = await leaveWorld(db);
		const id = await pendingOf(w);
		await raw
			.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?1`)
			.bind(w.users.managerUser.id)
			.run();
		expect(status(await approveAs(w.users.managerUser, id))).toBe(404);
		expect(status(await approveAs(w.users.admin, id))).toBe(404);
		expect(dataOf(await approveAs(w.users.hr, id)).decided).toBe('Request approved.');
	});

	it('a terminated manager record drops the manager right; HR decides (designated approver = HR)', async () => {
		const w = await leaveWorld(db);
		const id = await pendingOf(w);
		await raw
			.prepare(`UPDATE employees SET status = 'terminated' WHERE id = ?1`)
			.bind(w.employees.manager)
			.run();
		expect(status(await approveAs(w.users.managerUser, id))).toBe(404);
		expect(dataOf(await approveAs(w.users.hr2, id)).decided).toBe('Request approved.');
	});

	it('report moved to another manager after the queue loaded: the old manager gets 404, the new one decides', async () => {
		const w = await leaveWorld(db);
		const id = await pendingOf(w);
		const queue = dataOf(await run(approvals.load, req(w.users.managerUser, '/time-off/approvals')))
			.queue as { id: string; updatedAt: number }[];
		const row = queue.find((q) => q.id === id)!;
		expect(row).toBeTruthy();
		await raw
			.prepare(`UPDATE employees SET manager_id = ?1 WHERE id = ?2`)
			.bind(w.employees.top, w.employees.report)
			.run();
		expect(status(await approveAs(w.users.managerUser, id, String(row.updatedAt)))).toBe(404);
		expect((await requestRow(db, id))!.status).toBe('pending');
		expect(dataOf(await approveAs(w.users.topUser, id)).decided).toBe('Request approved.');
	});

	it('HR never decides their own request, also when their record names themselves as manager', async () => {
		const w = await leaveWorld(db);
		await raw
			.prepare(`UPDATE employees SET manager_id = id WHERE id = ?1`)
			.bind(w.employees.hr)
			.run();
		const made = await requestAs(db, w.users.hr, { typeId: 'lt_sick', startOn: base });
		if (!made.ok) throw new Error('request failed');
		expect(status(await approveAs(w.users.hr, made.id))).toBe(404);
		const viewer = await loadViewer(db, w.users.hr);
		expect(
			(
				dataOf(await run(approvals.load, req(w.users.hr, '/time-off/approvals'))).queue as {
					id: string;
				}[]
			).some((q) => q.id === made.id)
		).toBe(false);
		expect(viewer.isHr).toBe(true);
		expect(dataOf(await approveAs(w.users.hr2, made.id)).decided).toBe('Request approved.');
	});

	it('FIXED L5: the approver rule is re-asserted in the decision batch (a manager change mid-decide writes nothing)', async () => {
		const w = await leaveWorld(db);
		const id = await pendingOf(w);
		const manager = await loadViewer(db, w.users.managerUser);
		let moved = false;
		// HR moves the report to another manager between decide()'s re-read and its batch.
		const client = new Proxy(raw, {
			get(target, prop) {
				if (prop === 'batch')
					return async (statements: D1PreparedStatement[]) => {
						if (!moved) {
							moved = true;
							await raw
								.prepare(`UPDATE employees SET manager_id = ?1 WHERE id = ?2`)
								.bind(w.employees.top, w.employees.report)
								.run();
						}
						return raw.batch(statements);
					};
				const value = Reflect.get(target, prop) as unknown;
				return typeof value === 'function'
					? (value as (...a: unknown[]) => unknown).bind(target)
					: value;
			}
		});
		const wrapped = { $client: client } as unknown as Db;
		const result = await decide(
			wrapped,
			manager,
			id,
			'approve',
			'',
			Number(await expectedOf(id)),
			Date.now()
		);
		expect(moved).toBe(true);
		expect(result).toEqual({ ok: false, reason: 'not_found' });
		const row = (await requestRow(db, id))!;
		expect(row.status).toBe('pending');
		expect(row.decidedBy).toBeNull();
		expect((await ledgerRows(db, w.employees.report)).some((l) => l.kind === 'usage')).toBe(false);
		// The new manager (top) decides it.
		expect(dataOf(await approveAs(w.users.topUser, id)).decided).toBe('Request approved.');
	});
});

describe('IDOR and HR-only settings', () => {
	it('another employee, the manager and an admin cannot cancel the report’s request', async () => {
		const w = await leaveWorld(db);
		const id = await pendingOf(w);
		for (const user of [w.users.managerUser, w.users.outsider, w.users.admin, w.users.hr]) {
			// The "own" cancel is bound to the requester, HR included.
			expect(status(await cancelOwn(user, id))).toBe(404);
		}
		for (const user of [w.users.managerUser, w.users.admin, w.users.reportUser])
			expect(
				status(
					await run(
						team.actions.cancel,
						req(user, '/time-off/team?/cancel', { id, expected: await expectedOf(id) })
					)
				)
			).toBe(404);
		expect((await requestRow(db, id))!.status).toBe('pending');
		// Missing and malformed ids give the same 404.
		expect(status(await cancelOwn(w.users.reportUser, crypto.randomUUID(), '1'))).toBe(404);
		expect(status(await cancelOwn(w.users.reportUser, "x' OR 1=1 --", '1'))).toBe(404);
	});

	it('every settings action is a 404 for a manager, an admin and a member, and writes nothing', async () => {
		const w = await leaveWorld(db);
		const year = yearOf(today) + 1;
		const holidayDate = `${year}-08-17`;
		expect(
			dataOf(
				await run(
					settings.actions.holidaySave,
					req(w.users.hr, '/time-off/settings?/holidaySave', {
						onDate: holidayDate,
						name: 'Fictional day'
					})
				)
			).saved
		).toBe('Holiday added.');
		const holiday = await raw
			.prepare(`SELECT id FROM holidays WHERE on_date = ?1 AND deleted_at IS NULL`)
			.bind(holidayDate)
			.first<{ id: string }>();
		const work = await raw
			.prepare(`SELECT value, updated_at AS u FROM app_meta WHERE key = 'work_days'`)
			.first<{ value: string; u: number }>();
		const ledgerBefore = (await raw
			.prepare('SELECT count(*) AS n FROM leave_ledger')
			.first<{ n: number }>())!.n;
		const typesBefore = (await raw
			.prepare('SELECT count(*) AS n FROM leave_types')
			.first<{ n: number }>())!.n;
		const forms: [unknown, Record<string, string> | [string, string][]][] = [
			[settings.actions.typeSave, { name: 'Free days', kind: 'logged' }],
			[
				settings.actions.typeSave,
				{ id: 'lt_annual', name: 'Annual', annualDays: '365', active: 'on', expected: '0' }
			],
			[settings.actions.holidaySave, { onDate: `${year}-09-01`, name: 'Sneaky' }],
			[settings.actions.holidayDelete, { id: holiday!.id }],
			[
				settings.actions.workDays,
				[
					['day', '1'],
					['expected', String(work!.u)]
				]
			],
			[
				settings.actions.adjust,
				{
					employeeId: w.employees.report,
					typeId: 'lt_annual',
					period: String(yearOf(today)),
					days: '60',
					note: 'gift'
				}
			],
			[settings.actions.grantYear, { year: String(yearOf(today)) }]
		];
		for (const user of [w.users.managerUser, w.users.admin, w.users.reportUser, w.users.outsider]) {
			expect(status(await run(settings.load, req(user, '/time-off/settings')))).toBe(404);
			for (const [fn, form] of forms)
				expect(status(await run(fn, req(user, '/time-off/settings', form)))).toBe(404);
		}
		expect(
			(await raw
				.prepare('SELECT deleted_at AS d FROM holidays WHERE id = ?1')
				.bind(holiday!.id)
				.first<{ d: number | null }>())!.d
		).toBeNull();
		expect(
			(await raw
				.prepare(`SELECT value FROM app_meta WHERE key = 'work_days'`)
				.first<{ value: string }>())!.value
		).toBe(work!.value);
		expect(
			(await raw.prepare('SELECT count(*) AS n FROM leave_ledger').first<{ n: number }>())!.n
		).toBe(ledgerBefore);
		expect(
			(await raw.prepare('SELECT count(*) AS n FROM leave_types').first<{ n: number }>())!.n
		).toBe(typesBefore);
	});
});

describe('balances and the ledger', () => {
	it('approve racing cancel: exactly one wins and the ledger matches the final status', async () => {
		for (let i = 0; i < 4; i += 1) {
			const w = await leaveWorld(db);
			const id = await pendingOf(w, i * 7);
			const expected = await expectedOf(id);
			const results = await Promise.all([
				approveAs(w.users.managerUser, id, expected),
				cancelOwn(w.users.reportUser, id, expected)
			]);
			expect(results.filter((r) => status(r) === 200)).toHaveLength(1);
			const row = (await requestRow(db, id))!;
			const kinds = (await ledgerRows(db, w.employees.report))
				.filter((r) => r.requestId === id)
				.map((r) => r.kind);
			expect(kinds).toEqual(row.status === 'approved' ? ['usage'] : []);
		}
	});

	it('five parallel cancels of an approved request refund exactly once', async () => {
		const w = await leaveWorld(db);
		const id = await pendingOf(w, 0, 6);
		expect(status(await approveAs(w.users.managerUser, id))).toBe(200);
		const expected = await expectedOf(id);
		const period = yearOf(base);
		await Promise.all(Array.from({ length: 5 }, () => cancelOwn(w.users.reportUser, id, expected)));
		const kinds = (await ledgerRows(db, w.employees.report))
			.filter((r) => r.requestId === id)
			.map((r) => r.kind);
		expect(kinds).toEqual(['usage', 'reversal']);
		expect(await ledgerSum(w.employees.report, period)).toBe(24);
	});

	it('the same dates in two types at once: one request wins (overlap guard is type-blind)', async () => {
		const w = await leaveWorld(db);
		const [range] = rangesOf(base, 4, 1);
		const results = await Promise.all([
			requestAs(db, w.users.reportUser, { ...range!, typeId: 'lt_annual' }),
			requestAs(db, w.users.reportUser, { ...range!, typeId: 'lt_sick' }),
			requestAs(db, w.users.reportUser, { ...range!, typeId: 'lt_unpaid' })
		]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
	});

	it('negative adjustment racing an approval never takes the balance below zero', async () => {
		const w = await leaveWorld(db);
		const id = await pendingOf(w, 0, 20);
		const period = yearOf(base);
		const results = await Promise.all([
			approveAs(w.users.managerUser, id),
			run(
				settings.actions.adjust,
				req(w.users.hr, '/time-off/settings?/adjust', {
					employeeId: w.employees.report,
					typeId: 'lt_annual',
					period: String(period),
					days: '-2.5',
					note: 'correction'
				})
			)
		]);
		expect(status(results[0])).toBe(200);
		expect(status(results[1])).toBe(409);
		const [b] = (await balancesFor(db, [w.employees.report], period)).filter(
			(x) => x.typeId === 'lt_annual'
		);
		expect(b!.available).toBeGreaterThanOrEqual(0);
		expect(await ledgerSum(w.employees.report, period)).toBe(4);
	});

	it('the app cannot rewrite the ledger: raw UPDATE/DELETE abort; a logged type cannot be adjusted', async () => {
		const w = await leaveWorld(db);
		await pendingOf(w);
		await expect(raw.prepare('UPDATE leave_ledger SET half_days = 999').run()).rejects.toThrow(
			/append-only/
		);
		await expect(raw.prepare('DELETE FROM leave_ledger').run()).rejects.toThrow(/append-only/);
		const logged = await run(
			settings.actions.adjust,
			req(w.users.hr, '/time-off/settings?/adjust', {
				employeeId: w.employees.report,
				typeId: 'lt_sick',
				period: String(yearOf(today)),
				days: '5',
				note: 'x'
			})
		);
		expect(status(logged)).toBe(400);
		const bogus = await run(
			settings.actions.adjust,
			req(w.users.hr, '/time-off/settings?/adjust', {
				employeeId: crypto.randomUUID(),
				typeId: 'lt_annual',
				period: String(yearOf(today)),
				days: '5',
				note: 'x'
			})
		);
		expect(status(bogus)).toBe(400);
	});

	it('FIXED L2 (owner: allowed, flagged): HR acting on their own balance or leave is audited as self', async () => {
		const w = await leaveWorld(db);
		const period = yearOf(today);
		const own = await run(
			settings.actions.adjust,
			req(w.users.hr, '/time-off/settings?/adjust', {
				employeeId: w.employees.hr,
				typeId: 'lt_annual',
				period: String(period),
				days: '60',
				note: 'self gift'
			})
		);
		expect(dataOf(own).saved).toBe('Balance adjusted.');
		const audit = (await auditRows(db, { employeeId: w.employees.hr })).filter(
			(a) => a.action === 'leave_adjust'
		);
		expect(audit.at(-1)).toMatchObject({
			actorId: w.users.hr.id,
			userId: w.users.hr.id,
			detail: `${period} · self`
		});

		const day = pastWorkDay();
		const made = await requestAs(db, w.users.hr, { startOn: day });
		if (!made.ok) throw new Error(`request failed: ${made.reason}`);
		expect(status(await approveAs(w.users.hr2, made.id))).toBe(200);
		// Leave already taken; HR cancels it themselves as an "override" and gets the days back.
		expect(dataOf(await cancelOwn(w.users.hr, made.id)).canceled).toBe('Request canceled.');
		const kinds = (await ledgerRows(db, w.employees.hr))
			.filter((r) => r.requestId === made.id)
			.map((r) => r.kind);
		expect(kinds).toEqual(['usage', 'reversal']);
		const override = (await auditRows(db, { employeeId: w.employees.hr })).filter(
			(a) => a.action === 'leave_override'
		);
		expect(override.at(-1)).toMatchObject({ userId: w.users.hr.id, detail: 'canceled · self' });
		// /hr/audit highlights both as self.
		const page = dataOf(await run(hrAudit.load, req(w.users.hr, '/hr/audit')));
		const selfRows = (page.rows as { action: string; self: boolean }[]).filter((r) => r.self);
		expect(selfRows.map((r) => r.action)).toEqual(
			expect.arrayContaining(['leave_adjust', 'leave_override'])
		);
	});

	it('FIXED L4: leave cannot start before the employee’s start date', async () => {
		const w = await leaveWorld(db);
		const newcomer = await insertUser(db, { name: `Newcomer ${w.tag}` });
		await seedEmployee(
			db,
			w.users.hr.id,
			{
				fullName: `Newcomer Person ${w.tag}`,
				managerId: w.employees.manager,
				startOn: addDays(base, 60)
			},
			newcomer.id
		);
		const made = await requestAs(db, newcomer, { typeId: 'lt_sick', startOn: base });
		expect(made).toEqual({ ok: false, reason: 'before_start' });
		const action = await run(
			mine.actions.request,
			req(newcomer, '/time-off?/request', { typeId: 'lt_sick', startOn: base })
		);
		expect(status(action)).toBe(400);
		expect((dataOf(action).errors as Record<string, string>).startOn).toBe(
			'Leave can start on or after your start date.'
		);
		const [late] = rangesOf(addDays(base, 63), 2, 1);
		expect((await requestAs(db, newcomer, { typeId: 'lt_sick', ...late! })).ok).toBe(true);
	});

	it('FIXED L3: after a relink only the currently linked account can cancel the record’s leave', async () => {
		const w = await leaveWorld(db);
		const id = await pendingOf(w, 0, 4);
		expect(status(await approveAs(w.users.managerUser, id))).toBe(200);
		const successor = await insertUser(db, { name: `Successor ${w.tag}` });
		await raw
			.prepare('UPDATE employees SET user_id = ?1 WHERE id = ?2')
			.bind(successor.id, w.employees.report)
			.run();
		expect((await loadViewer(db, w.users.reportUser)).ownEmployeeId).toBeNull();
		expect(status(await cancelOwn(w.users.reportUser, id))).toBe(404);
		expect((await requestRow(db, id))!.status).toBe('approved');
		expect(dataOf(await cancelOwn(successor, id)).canceled).toBe('Request canceled.');
		const kinds = (await ledgerRows(db, w.employees.report))
			.filter((r) => r.requestId === id)
			.map((r) => r.kind);
		expect(kinds).toEqual(['usage', 'reversal']);
	});
});

describe('data leakage', () => {
	it('calendar payload for a member: names and day parts only, never type, reason, status or ids', async () => {
		const w = await leaveWorld(db);
		const reason = `Fictional diagnosis ${w.tag}`;
		const [a, b] = rangesOf(base, 2, 2);
		const sick = await requestAs(db, w.users.reportUser, { typeId: 'lt_sick', reason, ...a! });
		const pend = await requestAs(db, w.users.reportUser, {
			typeId: 'lt_unpaid',
			reason: `Pending ${w.tag}`,
			...b!
		});
		if (!sick.ok || !pend.ok) throw new Error('request failed');
		expect(status(await approveAs(w.users.managerUser, sick.id))).toBe(200);
		const loaded = dataOf(
			await run(
				calendar.load,
				req(w.users.outsider, `/time-off/calendar?month=${a!.startOn.slice(0, 7)}`)
			)
		);
		const json = JSON.stringify(loaded);
		expect(json).toContain(`Report Person ${w.tag}`);
		for (const leak of [
			reason,
			`Pending ${w.tag}`,
			'Sick',
			'Unpaid',
			'lt_',
			sick.id,
			pend.id,
			w.employees.report,
			'approved',
			'pending'
		])
			expect(json).not.toContain(leak);
		for (const week of loaded.weeks as ({ out: object[] } | null)[][])
			for (const cell of week)
				for (const entry of cell?.out ?? [])
					expect(Object.keys(entry).sort()).toEqual(['name', 'part']);
	});

	it('my page shows only my requests; the shell badge is a bare count', async () => {
		const w = await leaveWorld(db);
		const id = await pendingOf(w);
		const reason = `Secret reason ${w.tag}`;
		const made = await requestAs(db, w.users.loner, {
			typeId: 'lt_sick',
			startOn: addDays(base, 1),
			reason
		});
		if (!made.ok) throw new Error('request failed');
		const page = JSON.stringify(dataOf(await run(mine.load, req(w.users.reportUser, '/time-off'))));
		expect(page).toContain(id);
		expect(page).not.toContain(made.id);
		expect(page).not.toContain(reason);
		const shell = dataOf(await run(appLayout.load, req(w.users.managerUser, '/time-off')));
		expect(typeof shell.pendingApprovals).toBe('number');
		expect(Object.keys(shell).sort()).toEqual(['pendingApprovals', 'unread', 'user']);
	});

	it('approvals queue of a manager holds only direct reports, never the skip-level or other teams', async () => {
		const w = await leaveWorld(db);
		const id = await pendingOf(w);
		const other = await requestAs(db, w.users.loner, {
			typeId: 'lt_sick',
			startOn: addDays(base, 2)
		});
		if (!other.ok) throw new Error('request failed');
		const ids = (q: unknown) => (dataOf(q).queue as { id: string }[]).map((r) => r.id);
		const managerQueue = ids(
			await run(approvals.load, req(w.users.managerUser, '/time-off/approvals'))
		);
		expect(managerQueue).toEqual([id]);
		const topQueue = ids(await run(approvals.load, req(w.users.topUser, '/time-off/approvals')));
		expect(topQueue).not.toContain(id);
		expect(status(await run(team.load, req(w.users.outsider, '/time-off/team')))).toBe(404);
	});
});

describe('plumbing', () => {
	const resolve = vi.fn(
		async () => new Response('<p>page</p>', { headers: { 'content-type': 'text/html' } })
	);
	const hook = async (init: Parameters<typeof fakeEvent>[0]) => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		return handle({ event: fakeEvent(init).event, resolve } as never);
	};

	it('a cross-site POST to a time-off action is refused before the route runs', async () => {
		resolve.mockClear();
		const res = await hook({
			url: 'http://localhost/time-off/approvals?/approve',
			routeId: '/(app)/time-off/approvals',
			db,
			form: { id: crypto.randomUUID(), expected: '1' },
			headers: { origin: 'https://evil.example' }
		});
		expect(res.status).toBe(403);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('signed-in time-off pages and their __data.json are private, no-store', async () => {
		const user = await insertUser(db);
		const token = await insertSession(db, user.id);
		for (const url of [
			'http://localhost/time-off/calendar',
			'http://localhost/time-off/calendar/__data.json'
		]) {
			const res = await hook({
				url,
				routeId: '/(app)/time-off/calendar',
				db,
				cookies: { ruby_session: token }
			});
			expect(res.headers.get('cache-control')).toBe('private, no-store');
		}
	});

	it('the 21st request in 10 minutes is throttled even when every attempt failed; others are unaffected', async () => {
		const w = await leaveWorld(db);
		let saturday = base;
		while (isoWeekday(saturday) !== 6) saturday = addDays(saturday, 1);
		const attempt = (user: SessionUser) =>
			run(
				mine.actions.request,
				req(user, '/time-off?/request', { typeId: 'lt_sick', startOn: saturday })
			);
		for (let i = 0; i < 20; i += 1) expect(status(await attempt(w.users.reportUser))).toBe(400);
		expect(status(await attempt(w.users.reportUser))).toBe(429);
		expect(status(await attempt(w.users.managerUser))).toBe(400);
	});

	it('date tampering through the action: impossible, far and huge ranges are 400 and write nothing', async () => {
		const w = await leaveWorld(db);
		const before = (await raw
			.prepare('SELECT count(*) AS n FROM leave_requests')
			.first<{ n: number }>())!.n;
		for (const [startOn, endOn] of [
			['2026-02-30', '2026-03-02'],
			['9999-12-31', '9999-12-31'],
			['1970-01-01', '1970-01-01'],
			[addDays(today, -30), addDays(today, 366)],
			[base, '2100-12-31']
		])
			expect(
				status(
					await run(
						mine.actions.request,
						req(w.users.reportUser, '/time-off?/request', {
							typeId: 'lt_sick',
							startOn: startOn!,
							endOn: endOn!
						})
					)
				)
			).toBe(400);
		expect(
			(await raw.prepare('SELECT count(*) AS n FROM leave_requests').first<{ n: number }>())!.n
		).toBe(before);
		// The month query clamps far months instead of scanning them.
		const far = dataOf(
			await run(calendar.load, req(w.users.outsider, '/time-off/calendar?month=9999-12'))
		);
		expect(far.next).toBeNull();
		expect(String(far.month) <= `${yearOf(today) + 2}-12`).toBe(true);
	});

	it('terminate and soft-delete hooks cancel only that employee’s pending requests, in the same batch (Info I1)', async () => {
		const w = await leaveWorld(db);
		const mine1 = await pendingOf(w);
		const other = await requestAs(db, w.users.loner, {
			typeId: 'lt_sick',
			startOn: addDays(base, 3)
		});
		if (!other.ok) throw new Error('request failed');
		const employee = (await getEmployee(db, w.employees.report))!;
		expect(
			await terminate(db, w.users.hr.id, employee, today, employee.updatedAt, Date.now())
		).toEqual({ ok: true });
		expect((await requestRow(db, mine1))!.status).toBe('canceled');
		expect((await requestRow(db, other.id))!.status).toBe('pending');
		// Soft delete (RB-05) cancels the loner's pending request in the same batch.
		const loner = (await getEmployee(db, w.employees.loner))!;
		expect(await softDelete(db, w.users.hr.id, loner.id, loner.updatedAt, Date.now())).toEqual({
			ok: true
		});
		expect(await requestRow(db, other.id)).toMatchObject({
			status: 'canceled',
			decisionNote: 'Employee record deleted'
		});
		expect(status(await approveAs(w.users.hr, other.id))).toBe(404);
	});
});
