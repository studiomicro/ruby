import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { loadViewer } from '#lib/server/hr/access';
import { getEmployee, terminate } from '#lib/server/hr/repo';
import { addDays, isoWeekday, yearOf } from '#lib/server/timeoff/calendar';
import {
	balancesFor,
	cancel,
	decide,
	decidableCount,
	ensureGrants,
	getRequest,
	grantYear,
	listApprovalQueue,
	requestLeave
} from '#lib/server/timeoff/repo';
import { teamToday } from '#lib/server/tasks/today';
import { applyMigration, openLocalD1 } from '../helpers/d1';
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
import { insertUser } from '../helpers/users';

/** RB-06 repo functions, loads and actions against local D1 (PRD › Acceptance criteria and Test plan). */

const binding: { DB?: D1Database; TEAM_TIME_ZONE: string } = { TEAM_TIME_ZONE: 'Asia/Jakarta' };
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const mine = await import('../../src/routes/(app)/time-off/+page.server');
const calendar = await import('../../src/routes/(app)/time-off/calendar/+page.server');
const approvals = await import('../../src/routes/(app)/time-off/approvals/+page.server');
const team = await import('../../src/routes/(app)/time-off/team/+page.server');
const settings = await import('../../src/routes/(app)/time-off/settings/+page.server');
const appLayout = await import('../../src/routes/(app)/+layout.server');

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

function req(
	user: SessionUser | null,
	path: string,
	form?: Record<string, string> | [string, string][]
) {
	return fakeEvent({ url: `http://localhost${path}`, db, user, form }).event;
}
const viewerOf = (user: SessionUser) => loadViewer(db, user);

describe('access', () => {
	it('refuses signed-out requests on every route and action', async () => {
		for (const fn of [mine.load, calendar.load, approvals.load, team.load, settings.load])
			expect(status(await run(fn, req(null, '/time-off')))).toBe(401);
		for (const fn of [
			mine.actions.request,
			mine.actions.cancel,
			mine.actions.preview,
			approvals.actions.approve,
			approvals.actions.reject,
			team.actions.cancel,
			settings.actions.typeSave,
			settings.actions.holidaySave,
			settings.actions.holidayDelete,
			settings.actions.workDays,
			settings.actions.adjust,
			settings.actions.grantYear
		])
			expect(status(await run(fn, req(null, '/time-off', { id: 'x' })))).toBe(401);
	});

	it('shows an account without an employee the empty state and refuses its requests', async () => {
		const w = await leaveWorld(db);
		const loaded = dataOf(await run(mine.load, req(w.users.outsider, '/time-off')));
		expect(loaded.linked).toBe(false);
		const refused = await run(
			mine.actions.request,
			req(w.users.outsider, '/time-off?/request', { typeId: 'lt_sick', startOn: base })
		);
		expect(status(refused)).toBe(403);
		// The calendar stays open to them.
		expect(status(await run(calendar.load, req(w.users.outsider, '/time-off/calendar')))).toBe(200);
	});

	it('gives non-HR the same 404 on settings and non-approvers 404 on approvals and team', async () => {
		const w = await leaveWorld(db);
		for (const user of [w.users.admin, w.users.reportUser, w.users.outsider])
			expect(status(await run(settings.load, req(user, '/time-off/settings')))).toBe(404);
		expect(
			status(
				await run(
					settings.actions.workDays,
					req(w.users.admin, '/time-off/settings?/workDays', [['day', '1']])
				)
			)
		).toBe(404);
		for (const user of [w.users.reportUser, w.users.outsider]) {
			expect(status(await run(approvals.load, req(user, '/time-off/approvals')))).toBe(404);
			expect(status(await run(team.load, req(user, '/time-off/team')))).toBe(404);
		}
		expect(status(await run(settings.load, req(w.users.hr, '/time-off/settings')))).toBe(200);
	});
});

describe('entitlements and grants', () => {
	it('grants 10 days for a 1 March start, 9 for 15 March, 12 the year after, none without a start date', async () => {
		const w = await leaveWorld(db);
		const year = yearOf(today);
		const march1 = await seedEmployee(db, w.users.hr.id, { startOn: `${year}-03-01` });
		const march15 = await seedEmployee(db, w.users.hr.id, { startOn: `${year}-03-15` });
		const none = await seedEmployee(db, w.users.hr.id, {});
		await ensureGrants(db, [march1, march15, none], year, w.users.hr.id, Date.now());
		await ensureGrants(db, [march1], year + 1, w.users.hr.id, Date.now());
		const b = await balancesFor(db, [march1, march15, none], year);
		const entitled = (id: string) =>
			b.find((x) => x.employeeId === id && x.typeId === 'lt_annual')!.entitled;
		expect(entitled(march1)).toBe(20);
		expect(entitled(march15)).toBe(18);
		expect(entitled(none)).toBe(0);
		expect(await ledgerRows(db, none)).toEqual([]);
		const next = await balancesFor(db, [march1], year + 1);
		expect(next[0]!.entitled).toBe(24);
	});

	it('writes exactly one lazy grant under 20 concurrent calls, and grantYear twice adds nothing', async () => {
		const w = await leaveWorld(db);
		const year = yearOf(today);
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				ensureGrants(db, [w.employees.report], year, w.users.reportUser.id, Date.now())
			)
		);
		expect(results.reduce((a, b) => a + b, 0)).toBe(1);
		expect(
			(await ledgerRows(db, w.employees.report)).filter((r) => r.kind === 'grant')
		).toHaveLength(1);
		await grantYear(db, w.users.hr.id, year + 1, Date.now());
		const again = await grantYear(db, w.users.hr.id, year + 1, Date.now());
		expect(again).toBe(0);
		const grants = (await ledgerRows(db, w.employees.report)).filter((r) => r.kind === 'grant');
		expect(grants.map((g) => g.period).sort()).toEqual([year, year + 1]);
	});
});

describe('no ledger writes on GET; no lazy grant for a past year', () => {
	it('page loads show the coming grant read-only; the first write action writes it once', async () => {
		const w = await leaveWorld(db);
		const year = yearOf(today);
		const pages: [unknown, SessionUser, string][] = [
			[mine.load, w.users.reportUser, '/time-off'],
			[team.load, w.users.managerUser, '/time-off/team'],
			[team.load, w.users.hr, `/time-off/team?year=${year + 1}`],
			[approvals.load, w.users.hr, '/time-off/approvals']
		];
		for (const [fn, user, path] of pages) expect(status(await run(fn, req(user, path)))).toBe(200);
		expect(await ledgerRows(db, w.employees.report)).toEqual([]);
		const page = dataOf(await run(mine.load, req(w.users.reportUser, '/time-off')));
		expect((page.balances as { entitled: number; available: number }[])[0]).toMatchObject({
			entitled: 24,
			available: 24
		});
		const made = await requestAs(db, w.users.reportUser, { startOn: base });
		expect(made.ok).toBe(true);
		const grants = (await ledgerRows(db, w.employees.report)).filter((l) => l.kind === 'grant');
		expect(grants).toEqual([
			{ kind: 'grant', halfDays: 24, period: yearOf(base), requestId: null }
		]);
	});

	it('a late request in last year’s period finds no lazy grant; HR’s explicit grant still works', async () => {
		const w = await leaveWorld(db);
		const lastYear = yearOf(today) - 1;
		const day = [22, 23, 24].map((d) => `${lastYear}-12-${d}`).find((d) => isoWeekday(d) <= 5)!;
		const late = await requestLeave(
			db,
			{ userId: w.users.reportUser.id, employeeId: w.employees.report },
			{
				typeId: 'lt_annual',
				startOn: day,
				endOn: day,
				halfDay: 'none',
				reason: '',
				period: lastYear,
				kind: 'balance'
			},
			Date.now()
		);
		expect(late).toMatchObject({ ok: false, reason: 'balance', available: 0 });
		expect((await ledgerRows(db, w.employees.report)).filter((l) => l.period === lastYear)).toEqual(
			[]
		);
		const b = await balancesFor(db, [w.employees.report], lastYear);
		expect(b[0]).toMatchObject({ entitled: 0 });
		await grantYear(db, w.users.hr.id, lastYear, Date.now());
		expect((await balancesFor(db, [w.employees.report], lastYear))[0]).toMatchObject({
			entitled: 24
		});
	});
});

describe('requests', () => {
	it('counts working days through the action, skipping a non-deducting holiday', async () => {
		const w = await leaveWorld(db);
		const [week] = rangesOf(base, 10, 1);
		const holiday = addDays(week!.startOn, 2);
		const added = await run(
			settings.actions.holidaySave,
			req(w.users.hr, '/time-off/settings?/holidaySave', { onDate: holiday, name: 'Fictional Day' })
		);
		expect(dataOf(added).saved).toBe('Holiday added.');
		const preview = await run(
			mine.actions.preview,
			req(w.users.reportUser, '/time-off?/preview', {
				typeId: 'lt_annual',
				startOn: week!.startOn,
				endOn: week!.endOn,
				halfDay: 'none'
			})
		);
		expect(dataOf(preview).preview).toBe('This request uses 4 days (1 holiday skipped).');
		const made = await run(
			mine.actions.request,
			req(w.users.reportUser, '/time-off?/request', {
				typeId: 'lt_annual',
				startOn: week!.startOn,
				endOn: week!.endOn,
				halfDay: 'none'
			})
		);
		expect(dataOf(made).requested).toBe('Leave requested: 4 days.');
		const [h] = await raw
			.prepare('SELECT id FROM holidays WHERE on_date = ?1 AND deleted_at IS NULL')
			.bind(holiday)
			.raw<[string]>();
		await run(
			settings.actions.holidayDelete,
			req(w.users.hr, '/time-off/settings?/holidayDelete', { id: h![0] })
		);
		// A range of only weekend days is refused; a half day counts 1.
		const sat = addDays(base, 5);
		const weekend = await run(
			mine.actions.request,
			req(w.users.reportUser, '/time-off?/request', {
				typeId: 'lt_sick',
				startOn: sat,
				endOn: addDays(sat, 1)
			})
		);
		expect(status(weekend)).toBe(400);
		const half = await requestAs(db, w.users.reportUser, {
			typeId: 'lt_sick',
			startOn: addDays(base, 70),
			halfDay: 'am'
		});
		expect(half.ok && half.halfDays).toBe(1);
	});

	it('refuses more than the balance, accepts exactly the balance; pending counts, rejected and canceled release', async () => {
		const w = await leaveWorld(db);
		const [a, b] = rangesOf(base, 24, 2);
		// 24 half-days available: 12 days + 0.5 is refused, exactly 12 is accepted.
		const [over] = rangesOf(base, 25, 1);
		const tooMuch = await requestAs(db, w.users.reportUser, over!);
		expect(tooMuch).toMatchObject({ ok: false, reason: 'balance', available: 24 });
		const exact = await requestAs(db, w.users.reportUser, a!);
		expect(exact.ok).toBe(true);
		const pendingBlocks = await requestAs(db, w.users.reportUser, { startOn: b!.startOn });
		expect(pendingBlocks).toMatchObject({ ok: false, reason: 'balance', available: 0 });
		// Rejected releases.
		const manager = await viewerOf(w.users.managerUser);
		const row = await requestRow(db, (exact as { id: string }).id);
		expect(
			await decide(
				db,
				manager,
				(exact as { id: string }).id,
				'reject',
				'Busy month',
				row!.updatedAt,
				Date.now()
			)
		).toEqual({ ok: true });
		const again = await requestAs(db, w.users.reportUser, { startOn: b!.startOn });
		expect(again.ok).toBe(true);
		// Canceled releases.
		const ctx = await getRequest(db, (again as { id: string }).id);
		const me = await viewerOf(w.users.reportUser);
		expect(await cancel(db, me, ctx!, false, ctx!.updatedAt, today, Date.now())).toEqual({
			ok: true
		});
		expect((await requestAs(db, w.users.reportUser, a!)).ok).toBe(true);
	});

	it('race: 10 parallel requests of 6 days against 12 available yield exactly 2 pending', async () => {
		const w = await leaveWorld(db);
		const ranges = rangesOf(base, 12, 10);
		const results = await Promise.all(ranges.map((r) => requestAs(db, w.users.reportUser, r)));
		expect(results.filter((r) => r.ok)).toHaveLength(2);
		expect(results.filter((r) => !r.ok && r.reason === 'balance')).toHaveLength(8);
		const b = await balancesFor(db, [w.employees.report], yearOf(base));
		expect(b[0]).toMatchObject({ entitled: 24, pending: 24, available: 0 });
	});

	it('refuses overlapping ranges (also concurrently); adjacent, rejected and canceled do not block', async () => {
		const w = await leaveWorld(db);
		const [r1, r2] = rangesOf(base, 4, 2);
		const both = await Promise.all([
			requestAs(db, w.users.loner, { typeId: 'lt_sick', ...r1! }),
			requestAs(db, w.users.loner, { typeId: 'lt_sick', ...r1! })
		]);
		expect(both.filter((r) => r.ok)).toHaveLength(1);
		expect(both.find((r) => !r.ok)).toMatchObject({ reason: 'overlap' });
		expect((await requestAs(db, w.users.loner, { typeId: 'lt_sick', ...r2! })).ok).toBe(true);
		// Morning and afternoon of one date do not overlap; two mornings do.
		const day = addDays(r2!.endOn, 7);
		expect(
			(await requestAs(db, w.users.loner, { typeId: 'lt_sick', startOn: day, halfDay: 'am' })).ok
		).toBe(true);
		expect(
			(await requestAs(db, w.users.loner, { typeId: 'lt_sick', startOn: day, halfDay: 'pm' })).ok
		).toBe(true);
		expect(
			await requestAs(db, w.users.loner, { typeId: 'lt_sick', startOn: day, halfDay: 'am' })
		).toMatchObject({
			reason: 'overlap'
		});
		// A canceled range is free again.
		const first = both.find((r) => r.ok) as { id: string };
		const ctx = await getRequest(db, first.id);
		await cancel(db, await viewerOf(w.users.loner), ctx!, false, ctx!.updatedAt, today, Date.now());
		expect((await requestAs(db, w.users.loner, { typeId: 'lt_sick', ...r1! })).ok).toBe(true);
	});

	it('probe: 20 concurrent requests against the pending limit leave exactly 10 pending', async () => {
		const w = await leaveWorld(db);
		const days = rangesOf(base, 2, 20);
		const results = await Promise.all(
			days.map((d) => requestAs(db, w.users.loner, { typeId: 'lt_sick', ...d }))
		);
		expect(results.filter((r) => r.ok)).toHaveLength(10);
		expect(results.filter((r) => !r.ok && r.reason === 'pending_max')).toHaveLength(10);
		const action = await run(
			mine.actions.request,
			req(w.users.loner, '/time-off?/request', { typeId: 'lt_sick', startOn: addDays(base, 100) })
		);
		expect(status(action)).toBe(409);
		expect(dataOf(action).error).toMatch(/10 pending requests/);
	});

	it('refuses the date rules through the action, with the split message across New Year', async () => {
		const w = await leaveWorld(db);
		const year = yearOf(today);
		const post = (fields: Record<string, string>) =>
			run(
				mine.actions.request,
				req(w.users.reportUser, '/time-off?/request', { halfDay: 'none', ...fields })
			);
		const split = await post({
			typeId: 'lt_annual',
			startOn: `${year}-12-30`,
			endOn: `${year + 1}-01-02`
		});
		expect(status(split)).toBe(400);
		expect((dataOf(split).errors as Record<string, string>).endOn).toMatch(/split it/);
		expect(status(await post({ typeId: 'lt_sick', startOn: addDays(today, -31) }))).toBe(400);
		expect(status(await post({ typeId: 'lt_sick', startOn: '2026-02-30' }))).toBe(400);
		expect(status(await post({ typeId: 'lt_special', startOn: base }))).toBe(400);
	});
});

describe('approval', () => {
	async function pending(
		w: Awaited<ReturnType<typeof leaveWorld>>,
		user = w.users.reportUser,
		typeId = 'lt_annual'
	) {
		const [r] = rangesOf(addDays(base, 30), 8, 1);
		const made = await requestAs(db, user, { typeId, ...r! });
		if (!made.ok) throw new Error(`request failed: ${made.reason}`);
		return { id: made.id, updatedAt: (await requestRow(db, made.id))!.updatedAt };
	}
	const approveAs = (user: SessionUser, p: { id: string; updatedAt: number }, note = '') =>
		run(
			approvals.actions.approve,
			req(user, '/time-off/approvals?/approve', { id: p.id, expected: String(p.updatedAt), note })
		);

	it('lets the manager approve; another manager, the employee, a member and a non-fallback admin get 404', async () => {
		const w = await leaveWorld(db);
		const p = await pending(w);
		for (const user of [w.users.topUser, w.users.reportUser, w.users.outsider, w.users.admin]) {
			const r = await approveAs(user, p);
			expect(status(r)).toBe(404);
		}
		expect((await requestRow(db, p.id))!.status).toBe('pending');
		expect(dataOf(await approveAs(w.users.managerUser, p)).decided).toBe('Request approved.');
		const ledger = await ledgerRows(db, w.employees.report);
		expect(ledger.filter((l) => l.kind === 'usage')).toEqual([
			{ kind: 'usage', halfDays: -8, period: yearOf(base), requestId: p.id }
		]);
		// A manager's routine approval is not an HR audit event.
		expect(
			(await auditRows(db, { employeeId: w.employees.report })).map((a) => a.action)
		).not.toContain('leave_override');
	});

	it('lets HR approve anyone but themselves (another HR decides theirs) and audits an override of a manager', async () => {
		const w = await leaveWorld(db);
		const p = await pending(w);
		expect(dataOf(await approveAs(w.users.hr, p)).decided).toBe('Request approved.');
		const audit = await auditRows(db, { employeeId: w.employees.report });
		expect(audit.at(-1)).toMatchObject({
			action: 'leave_override',
			actorId: w.users.hr.id,
			fields: '["status"]'
		});
		const own = await pending(w, w.users.hr);
		expect(status(await approveAs(w.users.hr, own))).toBe(404);
		expect(dataOf(await approveAs(w.users.hr2, own)).decided).toBe('Request approved.');
		// No manager: HR decides, and that is no override.
		const loner = await pending(w, w.users.loner);
		const before = (await auditRows(db, { employeeId: w.employees.loner })).length;
		expect(dataOf(await approveAs(w.users.hr2, loner)).decided).toBe('Request approved.');
		expect(await auditRows(db, { employeeId: w.employees.loner })).toHaveLength(before);
	});

	it('double approve: one wins, the other gets 409 "already decided"; usage is written once', async () => {
		const w = await leaveWorld(db);
		const p = await pending(w);
		const results = await Promise.all([
			approveAs(w.users.managerUser, p),
			approveAs(w.users.hr, p)
		]);
		expect(results.filter((r) => dataOf(r).decided)).toHaveLength(1);
		const loser = results.find((r) => status(r) === 409);
		expect(dataOf(loser).error).toMatch(/already decided by (Manager|HR)/);
		const ledger = await ledgerRows(db, w.employees.report);
		expect(ledger.filter((l) => l.kind === 'usage')).toHaveLength(1);
		const sum = ledger.reduce((s, l) => s + l.halfDays, 0);
		expect(sum).toBe(24 - 8);
	});

	it('recomputes at approval: a new holiday lowers the days, a longer week that needs more balance is refused', async () => {
		const w = await leaveWorld(db);
		const [week] = rangesOf(addDays(base, 42), 10, 1);
		const made = await requestAs(db, w.users.reportUser, week!);
		if (!made.ok) throw new Error('request failed');
		const hr = await viewerOf(w.users.hr);
		await run(
			settings.actions.holidaySave,
			req(w.users.hr, '/time-off/settings?/holidaySave', {
				onDate: addDays(week!.startOn, 1),
				name: 'Late Holiday'
			})
		);
		const row = await requestRow(db, made.id);
		expect(await decide(db, hr, made.id, 'approve', '', row!.updatedAt, Date.now())).toEqual({
			ok: true
		});
		expect((await requestRow(db, made.id))!.halfDays).toBe(8);
		const [h] = await raw
			.prepare(`SELECT id FROM holidays WHERE name = 'Late Holiday' AND deleted_at IS NULL`)
			.raw<[string]>();
		await run(
			settings.actions.holidayDelete,
			req(w.users.hr, '/time-off/settings?/holidayDelete', { id: h![0] })
		);

		// Leave exactly the request's 10 half-days available, then add Saturday to the week: it now needs 12.
		const [next] = rangesOf(addDays(base, 56), 10, 1);
		const spare = 24 - 8 - 10;
		await run(
			settings.actions.adjust,
			req(w.users.hr, '/time-off/settings?/adjust', {
				employeeId: w.employees.report,
				typeId: 'lt_annual',
				period: String(yearOf(base)),
				days: String(-spare / 2),
				note: 'Fictional correction'
			})
		);
		const endsSaturday = { startOn: next!.startOn, endOn: addDays(next!.startOn, 5) };
		const second = await requestAs(db, w.users.reportUser, endsSaturday);
		if (!second.ok) throw new Error(`second request failed: ${second.reason}`);
		const { updatedAt: wd } = (await raw
			.prepare(`SELECT updated_at AS updatedAt FROM app_meta WHERE key = 'work_days'`)
			.first<{ updatedAt: number }>())!;
		await run(
			settings.actions.workDays,
			req(w.users.hr, '/time-off/settings?/workDays', [
				...['1', '2', '3', '4', '5', '6'].map((d): [string, string] => ['day', d]),
				['expected', String(wd)]
			])
		);
		const r2 = await requestRow(db, second.id);
		const refused = await run(
			approvals.actions.approve,
			req(w.users.hr, '/time-off/approvals?/approve', {
				id: second.id,
				expected: String(r2!.updatedAt)
			})
		);
		expect(status(refused)).toBe(409);
		expect(dataOf(refused).error).toBe(
			'Not enough balance: 5 days available, this request now needs 6.'
		);
		const { updatedAt: wd2 } = (await raw
			.prepare(`SELECT updated_at AS updatedAt FROM app_meta WHERE key = 'work_days'`)
			.first<{ updatedAt: number }>())!;
		await run(
			settings.actions.workDays,
			req(w.users.hr, '/time-off/settings?/workDays', [
				...['1', '2', '3', '4', '5'].map((d): [string, string] => ['day', d]),
				['expected', String(wd2)]
			])
		);
		expect((await requestRow(db, second.id))!.status).toBe('pending');
	});

	it('reject stores the note, the requester sees it, the ledger is untouched', async () => {
		const w = await leaveWorld(db);
		const p = await pending(w);
		const before = await ledgerRows(db, w.employees.report);
		const r = await run(
			approvals.actions.reject,
			req(w.users.managerUser, '/time-off/approvals?/reject', {
				id: p.id,
				expected: String(p.updatedAt),
				note: 'Team offsite that week'
			})
		);
		expect(dataOf(r).decided).toBe('Request rejected.');
		expect(await ledgerRows(db, w.employees.report)).toEqual(before);
		const page = dataOf(await run(mine.load, req(w.users.reportUser, '/time-off')));
		const shown = (
			page.requests as { id: string; status: string; decisionNote: string; decidedByName: string }[]
		).find((x) => x.id === p.id);
		expect(shown).toMatchObject({ status: 'rejected', decisionNote: 'Team offsite that week' });
		expect(shown!.decidedByName).toMatch(/^Manager /);
	});

	it('the queue and the nav badge count exactly what the viewer may decide, and drop after a decision', async () => {
		const w = await leaveWorld(db);
		const p = await pending(w);
		const contractorFree = await pending(w, w.users.loner, 'lt_sick');
		const badge = async (user: SessionUser) =>
			dataOf(await run(appLayout.load, req(user, '/'))).pendingApprovals as number;
		const managerQueue = await listApprovalQueue(db, await viewerOf(w.users.managerUser));
		expect(managerQueue.map((q) => q.id)).toEqual([p.id]);
		expect(managerQueue[0]!.remainingAfter).toBe(24 - 8);
		expect(await badge(w.users.managerUser)).toBe(1);
		expect(await badge(w.users.topUser)).toBe(0);
		expect(await badge(w.users.reportUser)).toBe(0);
		const hrBefore = await badge(w.users.hr);
		expect(hrBefore).toBe(await decidableCount(db, w.users.hr.id));
		const hrQueue = await listApprovalQueue(db, await viewerOf(w.users.hr));
		expect(hrQueue.map((q) => q.id)).toEqual(expect.arrayContaining([p.id, contractorFree.id]));
		await approveAs(w.users.managerUser, p);
		expect(await badge(w.users.managerUser)).toBe(0);
		expect(await badge(w.users.hr)).toBe(hrBefore - 1);
	});

	it('the admin decides only when there is no manager and no other HR', async () => {
		const solo = await openLocalD1();
		try {
			const sdb = getDb(solo.db);
			const admin = await insertUser(sdb, { role: 'admin', name: 'Solo Admin' });
			const hrUser = await insertUser(sdb, { name: 'Solo HR' });
			await sdb.$client.prepare('UPDATE users SET is_hr = 1 WHERE id = ?1').bind(hrUser.id).run();
			await seedEmployee(
				sdb,
				hrUser.id,
				{ fullName: 'Solo HR Person', startOn: '2023-01-02' },
				hrUser.id
			);
			const viewer = await loadViewer(sdb, hrUser);
			const made = await requestLeave(
				sdb,
				{ userId: hrUser.id, employeeId: viewer.ownEmployeeId! },
				{
					typeId: 'lt_sick',
					startOn: base,
					endOn: base,
					halfDay: 'none',
					reason: '',
					period: yearOf(base),
					kind: 'logged'
				},
				Date.now()
			);
			if (!made.ok) throw new Error('request failed');
			expect(await decidableCount(sdb, admin.id)).toBe(1);
			// Another active admin is an eligible approver, so the only HR user may not self-approve.
			expect(await decidableCount(sdb, hrUser.id)).toBe(0);
			const ctx = await getRequest(sdb, made.id);
			const adminViewer = await loadViewer(sdb, admin);
			expect(
				await decide(sdb, adminViewer, made.id, 'approve', '', ctx!.updatedAt, Date.now())
			).toEqual({ ok: true });
		} finally {
			await solo.dispose();
		}
	});
});

describe('cancel', () => {
	it('cancels pending any time, approved only before the start, refunds once even when doubled', async () => {
		const w = await leaveWorld(db);
		const [r] = rangesOf(addDays(base, 14), 6, 1);
		const made = await requestAs(db, w.users.reportUser, r!);
		if (!made.ok) throw new Error('request failed');
		const hr = await viewerOf(w.users.hr);
		await decide(
			db,
			hr,
			made.id,
			'approve',
			'',
			(await requestRow(db, made.id))!.updatedAt,
			Date.now()
		);
		const updatedAt = (await requestRow(db, made.id))!.updatedAt;
		const post = () =>
			run(
				mine.actions.cancel,
				req(w.users.reportUser, '/time-off?/cancel', { id: made.id, expected: String(updatedAt) })
			);
		const results = await Promise.all([post(), post()]);
		for (const res of results) expect(dataOf(res).canceled).toBe('Request canceled.');
		const ledger = await ledgerRows(db, w.employees.report);
		expect(ledger.filter((l) => l.kind === 'reversal')).toEqual([
			{ kind: 'reversal', halfDays: 6, period: yearOf(base), requestId: made.id }
		]);
		const b = await balancesFor(db, [w.employees.report], yearOf(base));
		expect(b[0]).toMatchObject({ used: 0, available: 24 });
		// Someone else's request: 404.
		expect(
			status(
				await run(
					mine.actions.cancel,
					req(w.users.outsider, '/time-off?/cancel', { id: made.id, expected: String(updatedAt) })
				)
			)
		).toBe(404);
	});

	it('after the start only HR may cancel, writing a leave_override audit row', async () => {
		const w = await leaveWorld(db);
		const start = addDays(today, -20);
		const made = await requestAs(db, w.users.loner, {
			typeId: 'lt_sick',
			startOn: start,
			endOn: addDays(start, 3)
		});
		if (!made.ok) throw new Error(`request failed: ${made.reason}`);
		const hr2 = await viewerOf(w.users.hr2);
		await decide(
			db,
			hr2,
			made.id,
			'approve',
			'',
			(await requestRow(db, made.id))!.updatedAt,
			Date.now()
		);
		const row = (await requestRow(db, made.id))!;
		const own = await run(
			mine.actions.cancel,
			req(w.users.loner, '/time-off?/cancel', { id: made.id, expected: String(row.updatedAt) })
		);
		expect(status(own)).toBe(409);
		expect(dataOf(own).error).toMatch(/Ask HR/);
		// A manager may not cancel through the team page.
		expect(
			status(
				await run(
					team.actions.cancel,
					req(w.users.managerUser, '/time-off/team?/cancel', {
						id: made.id,
						expected: String(row.updatedAt)
					})
				)
			)
		).toBe(404);
		const byHr = await run(
			team.actions.cancel,
			req(w.users.hr, '/time-off/team?/cancel', { id: made.id, expected: String(row.updatedAt) })
		);
		expect(dataOf(byHr).canceled).toBe('Request canceled.');
		const audit = await auditRows(db, { employeeId: w.employees.loner });
		expect(audit.at(-1)).toMatchObject({ action: 'leave_override', detail: 'canceled' });
	});

	it('terminating an employee cancels their pending requests in the same batch; approved future leave stays', async () => {
		const w = await leaveWorld(db);
		const [a, b] = rangesOf(addDays(base, 7), 2, 2);
		const pendingOne = await requestAs(db, w.users.reportUser, { typeId: 'lt_sick', ...a! });
		const approvedOne = await requestAs(db, w.users.reportUser, { typeId: 'lt_sick', ...b! });
		if (!pendingOne.ok || !approvedOne.ok) throw new Error('request failed');
		const manager = await viewerOf(w.users.managerUser);
		await decide(
			db,
			manager,
			approvedOne.id,
			'approve',
			'',
			(await requestRow(db, approvedOne.id))!.updatedAt,
			Date.now()
		);
		const employee = (await getEmployee(db, w.employees.report))!;
		const result = await terminate(
			db,
			w.users.hr.id,
			employee,
			today,
			employee.updatedAt,
			Date.now()
		);
		expect(result).toEqual({ ok: true });
		expect(await requestRow(db, pendingOne.id)).toMatchObject({
			status: 'canceled',
			decisionNote: 'Employee left'
		});
		const approved = (await requestRow(db, approvedOne.id))!;
		expect(approved.status).toBe('approved');
		const byHr = await run(
			team.actions.cancel,
			req(w.users.hr, '/time-off/team?/cancel', {
				id: approvedOne.id,
				expected: String(approved.updatedAt)
			})
		);
		expect(dataOf(byHr).canceled).toBe('Request canceled.');
	});

	it('a refused termination cancels nothing', async () => {
		const w = await leaveWorld(db);
		const made = await requestAs(db, w.users.reportUser, { typeId: 'lt_sick', startOn: base });
		if (!made.ok) throw new Error('request failed');
		const employee = (await getEmployee(db, w.employees.report))!;
		const stale = await terminate(
			db,
			w.users.hr.id,
			employee,
			today,
			employee.updatedAt - 1,
			Date.now()
		);
		expect(stale.ok).toBe(false);
		expect((await requestRow(db, made.id))!.status).toBe('pending');
	});
});

describe('calendar and team', () => {
	it('shows approved leave by name only: never the type, the reason, pending or rejected requests', async () => {
		const w = await leaveWorld(db);
		const [r] = rangesOf(addDays(base, 21), 4, 1);
		const made = await requestAs(db, w.users.loner, {
			typeId: 'lt_special',
			reason: 'Fictional-secret-reason <script>',
			...r!
		});
		const hiddenPending = await requestAs(db, w.users.reportUser, { typeId: 'lt_sick', ...r! });
		if (!made.ok || !hiddenPending.ok) throw new Error('request failed');
		const hr = await viewerOf(w.users.hr);
		await decide(
			db,
			hr,
			made.id,
			'approve',
			'',
			(await requestRow(db, made.id))!.updatedAt,
			Date.now()
		);
		const month = r!.startOn.slice(0, 7);
		const page = await run(
			calendar.load,
			req(w.users.outsider, `/time-off/calendar?month=${month}`)
		);
		const payload = JSON.stringify(page);
		expect(payload).toContain(`Loner Person ${w.tag}`);
		expect(payload).not.toContain(`Report Person ${w.tag}`);
		for (const secret of [
			'Special',
			'Fictional-secret-reason',
			'lt_special',
			made.id,
			'approved',
			'pending',
			'reason'
		])
			expect(payload).not.toContain(secret);
		const cell = (dataOf(page).weeks as ({ date: string; out: unknown[] } | null)[][])
			.flat()
			.find((d) => d?.date === r!.startOn);
		expect(cell!.out).toContainEqual({ name: `Loner Person ${w.tag}`, part: 'none' });
		// The month window clamps to 12 months around today.
		const far = dataOf(
			await run(calendar.load, req(w.users.outsider, '/time-off/calendar?month=2099-01'))
		);
		expect(far.next).toBeNull();
	});

	it('team: the manager sees direct reports only, HR everyone, a skip-level manager not the report', async () => {
		const w = await leaveWorld(db);
		await requestAs(db, w.users.reportUser, { typeId: 'lt_sick', startOn: addDays(base, 3) });
		const names = async (user: SessionUser) =>
			(
				dataOf(await run(team.load, req(user, '/time-off/team'))).members as { fullName: string }[]
			).map((m) => m.fullName);
		expect((await names(w.users.managerUser)).sort()).toEqual(
			[`Contractor Person ${w.tag}`, `Report Person ${w.tag}`].sort()
		);
		const top = await names(w.users.topUser);
		expect(top).toEqual([`Manager Person ${w.tag}`]);
		const topPage = dataOf(await run(team.load, req(w.users.topUser, '/time-off/team')));
		expect(JSON.stringify(topPage)).not.toContain(`Report Person ${w.tag}`);
		expect(await names(w.users.hr)).toEqual(
			expect.arrayContaining([`Report Person ${w.tag}`, `Top Person ${w.tag}`])
		);
		// A foreign employee id in the filter is ignored, not trusted.
		const filtered = dataOf(
			await run(team.load, req(w.users.managerUser, `/time-off/team?employee=${w.employees.top}`))
		);
		expect((filtered.filters as { employee: string }).employee).toBe('');
	});
});

describe('settings, adjustments and the ledger', () => {
	it('adjusts within bounds with an audit row; a negative adjustment below zero is refused', async () => {
		const w = await leaveWorld(db);
		const year = String(yearOf(today));
		const post = (days: string, note = 'Carry-over from last year') =>
			run(
				settings.actions.adjust,
				req(w.users.hr, '/time-off/settings?/adjust', {
					employeeId: w.employees.report,
					typeId: 'lt_annual',
					period: year,
					days,
					note
				})
			);
		expect(dataOf(await post('2.5')).saved).toBe('Balance adjusted.');
		expect(status(await post('0'))).toBe(400);
		expect(status(await post('61'))).toBe(400);
		expect(status(await post('1', ''))).toBe(400);
		const below = await post('-15');
		expect(status(below)).toBe(409);
		expect(dataOf(below).error).toMatch(/14\.5 days available/);
		expect(dataOf(await post('-14.5')).saved).toBe('Balance adjusted.');
		const audit = (await auditRows(db, { employeeId: w.employees.report })).filter(
			(a) => a.action === 'leave_adjust'
		);
		expect(audit).toHaveLength(2);
		expect(audit[0]).toMatchObject({ fields: '["half_days"]', detail: year });
		const b = await balancesFor(db, [w.employees.report], Number(year));
		expect(b[0]!.available).toBe(0);
		// Members cannot adjust.
		expect(
			status(
				await run(
					settings.actions.adjust,
					req(w.users.managerUser, '/time-off/settings?/adjust', {
						employeeId: w.employees.report,
						typeId: 'lt_annual',
						period: year,
						days: '5',
						note: 'x'
					})
				)
			)
		).toBe(404);
	});

	it('audits type, holiday and work-day edits; refuses a 21st type, a duplicate date and a 7-day week', async () => {
		const solo = await openLocalD1();
		try {
			const sdb = getDb(solo.db);
			const hrUser = await insertUser(sdb, { name: 'Settings HR' });
			await sdb.$client.prepare('UPDATE users SET is_hr = 1 WHERE id = ?1').bind(hrUser.id).run();
			const at = (path: string, form?: Record<string, string> | [string, string][]) =>
				fakeEvent({ url: `http://localhost${path}`, db: sdb, user: hrUser, form }).event;
			const loaded = dataOf(await run(settings.load, at('/time-off/settings')));
			expect(loaded.noHolidaysThisYear).toBe(true);
			expect((loaded.types as { id: string }[]).map((t) => t.id)).toEqual([
				'lt_annual',
				'lt_sick',
				'lt_unpaid',
				'lt_special'
			]);
			for (let i = 0; i < 16; i += 1)
				expect(
					dataOf(
						await run(
							settings.actions.typeSave,
							at('/time-off/settings?/typeSave', { name: `Type ${i}`, kind: 'logged' })
						)
					).saved
				).toBe('Leave type added.');
			const full = await run(
				settings.actions.typeSave,
				at('/time-off/settings?/typeSave', { name: 'One too many', kind: 'logged' })
			);
			expect(status(full)).toBe(409);
			const dup = await run(
				settings.actions.typeSave,
				at('/time-off/settings?/typeSave', { name: 'annual', kind: 'logged' })
			);
			expect(status(dup)).toBe(409);
			const annual = (loaded.types as { id: string; updatedAt: number }[])[0]!;
			const renamed = await run(
				settings.actions.typeSave,
				at('/time-off/settings?/typeSave', {
					id: 'lt_annual',
					expected: String(annual.updatedAt),
					name: 'Annual leave',
					annualDays: '12',
					active: 'on'
				})
			);
			expect(dataOf(renamed).saved).toBe('Leave type saved.');
			const stale = await run(
				settings.actions.typeSave,
				at('/time-off/settings?/typeSave', {
					id: 'lt_annual',
					expected: String(annual.updatedAt),
					name: 'Again',
					active: 'on'
				})
			);
			expect(status(stale)).toBe(409);

			const year = yearOf(today);
			const h = { onDate: `${year}-08-17`, name: 'Fictional Independence Day' };
			expect(
				dataOf(await run(settings.actions.holidaySave, at('/time-off/settings?/holidaySave', h)))
					.saved
			).toBe('Holiday added.');
			expect(
				status(await run(settings.actions.holidaySave, at('/time-off/settings?/holidaySave', h)))
			).toBe(409);
			expect(dataOf(await run(settings.load, at('/time-off/settings'))).noHolidaysThisYear).toBe(
				false
			);

			const seven = await run(
				settings.actions.workDays,
				at('/time-off/settings?/workDays', [
					...['1', '2', '3', '4', '5', '6', '7'].map((d): [string, string] => ['day', d]),
					['expected', '0']
				])
			);
			expect(status(seven)).toBe(400);
			const six = await run(
				settings.actions.workDays,
				at('/time-off/settings?/workDays', [
					...['1', '2', '3', '4', '5', '6'].map((d): [string, string] => ['day', d]),
					['expected', '0']
				])
			);
			expect(dataOf(six).saved).toBe('Work days saved.');
			const actions = (await auditRows(sdb, { actorId: hrUser.id })).map((a) => a.action);
			expect(actions.filter((a) => a === 'leave_type_update')).toHaveLength(17);
			expect(actions).toContain('holiday_update');
			expect(actions).toContain('work_days_update');
		} finally {
			await solo.dispose();
		}
	});

	it('keeps the ledger and audit log append-only', async () => {
		const w = await leaveWorld(db);
		await ensureGrants(db, [w.employees.report], yearOf(today), w.users.hr.id, Date.now());
		await expect(raw.prepare('UPDATE leave_ledger SET half_days = 999').run()).rejects.toThrow(
			/append-only/
		);
		await expect(raw.prepare('DELETE FROM leave_ledger').run()).rejects.toThrow(/append-only/);
	});

	it('logs no reasons, names or leave types while requesting and deciding', async () => {
		const w = await leaveWorld(db);
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
			vi.spyOn(console, m)
		);
		try {
			const made = await run(
				mine.actions.request,
				req(w.users.reportUser, '/time-off?/request', {
					typeId: 'lt_special',
					startOn: addDays(base, 91),
					reason: 'Fictional-log-probe'
				})
			);
			expect(dataOf(made).requested).toBeTruthy();
			await run(approvals.load, req(w.users.managerUser, '/time-off/approvals'));
			await run(appLayout.load, req(w.users.managerUser, '/'));
			const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
			for (const secret of ['Fictional-log-probe', 'Special', w.tag])
				expect(logged).not.toContain(secret);
		} finally {
			for (const s of spies) s.mockRestore();
		}
	});
});

describe('migration 0003', () => {
	it('applies on a database with employees and seeds the four types and work_days', async () => {
		const old = await openLocalD1({ before: '0003' });
		try {
			const odb = getDb(old.db);
			const hrUser = await insertUser(odb, { name: 'Migration HR' });
			await seedEmployee(odb, hrUser.id, { fullName: 'Existing Person' });
			await applyMigration(old.db, '0003_time_off.sql');
			const types = await old.db
				.prepare(
					'SELECT id, kind, annual_half_days AS a, requires_reason AS r FROM leave_types ORDER BY sort'
				)
				.all();
			expect(types.results).toEqual([
				{ id: 'lt_annual', kind: 'balance', a: 24, r: 0 },
				{ id: 'lt_sick', kind: 'logged', a: 0, r: 0 },
				{ id: 'lt_unpaid', kind: 'logged', a: 0, r: 0 },
				{ id: 'lt_special', kind: 'logged', a: 0, r: 1 }
			]);
			const wd = await old.db
				.prepare(`SELECT value FROM app_meta WHERE key = 'work_days'`)
				.first<{ value: string }>();
			expect(wd?.value).toBe('1,2,3,4,5');
			expect(
				(await old.db.prepare('SELECT count(*) AS n FROM employees').first<{ n: number }>())!.n
			).toBe(1);
		} finally {
			await old.dispose();
		}
	});
});
