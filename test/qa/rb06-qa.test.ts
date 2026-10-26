import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb, type Db } from '#lib/server/db';
import { loadViewer } from '#lib/server/hr/access';
import { annualEntitlement } from '#lib/server/timeoff/accrual';
import { addHoliday, balancesFor, cancel, decide, getRequest } from '#lib/server/timeoff/repo';
import { parseRequest } from '#lib/server/timeoff/validation';
import { applyMigration, openLocalD1 } from '../helpers/d1';
import { seedEmployee } from '../helpers/seed-hr';
import { leaveWorld, ledgerRows, requestAs, requestRow } from '../helpers/seed-leave';
import { insertUser } from '../helpers/users';

/** QA proof of the RB-06 balance arithmetic, worked by hand in QA_REPORT.md, on fixed dates (2026-11 / 2027-01). */

vi.mock('#lib/server/env', () => ({
	getEnv: () => ({ DB: undefined, TEAM_TIME_ZONE: 'Asia/Jakarta' })
}));
void applyMigration;

let db: Db;
let dispose: () => Promise<void>;
beforeAll(async () => {
	const opened = await openLocalD1();
	db = getDb(opened.db);
	dispose = opened.dispose;
});
afterAll(() => dispose());

describe('rb06 qa arithmetic', () => {
	it('prorates a 10 July 2026 joiner: 5 full months (Aug-Dec) = 10 half-days; 24 the next year', () => {
		// 10 Jul: not the 1st, so July does not count: 12 - 7 = 5 months; 24 * 5 / 12 = 10.
		expect(annualEntitlement({ startOn: '2026-07-10', period: 2026, annualHalfDays: 24 })).toBe(10);
		expect(annualEntitlement({ startOn: '2026-07-10', period: 2027, annualHalfDays: 24 })).toBe(24);
		expect(annualEntitlement({ startOn: '2026-07-10', period: 2025, annualHalfDays: 24 })).toBe(0);
		expect(annualEntitlement({ startOn: '2026-12-31', period: 2026, annualHalfDays: 24 })).toBe(0);
		expect(annualEntitlement({ startOn: '2026-12-01', period: 2026, annualHalfDays: 24 })).toBe(2);
	});

	it('year boundary: balance request 31 Dec -> 1 Jan refused (split); a logged one is accepted', () => {
		const types = [
			{ id: 'lt_annual', kind: 'balance' as const, requiresReason: false, active: true },
			{ id: 'lt_sick', kind: 'logged' as const, requiresReason: false, active: true }
		];
		const form = (typeId: string) => {
			const f = new FormData();
			f.set('typeId', typeId);
			f.set('startOn', '2026-12-31');
			f.set('endOn', '2027-01-01');
			return f;
		};
		const a = parseRequest(form('lt_annual'), types, '2026-10-26');
		expect(a.ok).toBe(false);
		if (!a.ok) expect(a.errors.endOn).toMatch(/split/);
		expect(parseRequest(form('lt_sick'), types, '2026-10-26').ok).toBe(true);
	});

	it('hand-worked ledger: holiday, weekend, deducting holiday, half day, cancel after approval', async () => {
		const w = await leaveWorld(db);
		const user = await insertUser(db, { name: `Joiner ${w.tag}` });
		const emp = await seedEmployee(
			db,
			w.users.hr.id,
			{ fullName: `Joiner ${w.tag}`, startOn: '2026-07-10', department: w.department },
			user.id
		);
		const hr = await loadViewer(db, w.users.hr);
		const t = 1_700_000_000_000;
		// Wed 4 Nov 2026 public holiday (does not deduct); Wed 11 Nov deducts leave.
		expect(
			(
				await addHoliday(
					db,
					w.users.hr.id,
					{ onDate: '2026-11-04', name: 'H1', deductsLeave: false },
					t
				)
			).ok
		).toBe(true);
		expect(
			(
				await addHoliday(
					db,
					w.users.hr.id,
					{ onDate: '2026-11-11', name: 'H2', deductsLeave: true },
					t
				)
			).ok
		).toBe(true);

		// Mon 2 - Fri 6 Nov: 5 weekdays - 1 holiday = 4 days = 8 half-days. Entitled 10 -> available 2.
		const r1 = await requestAs(db, user, { startOn: '2026-11-02', endOn: '2026-11-06' });
		expect(r1).toMatchObject({ ok: true, halfDays: 8 });
		let b = (await balancesFor(db, [emp], 2026))[0]!;
		expect(b).toMatchObject({ entitled: 10, used: 0, pending: 8, available: 2 });

		// Sat 7 - Mon 9: weekend skipped, Monday = 2 half-days = exactly the 2 available: accepted.
		const r2 = await requestAs(db, user, { startOn: '2026-11-07', endOn: '2026-11-09' });
		expect(r2).toMatchObject({ ok: true, halfDays: 2 });
		// Anything more is refused: balance 0 now.
		expect(await requestAs(db, user, { startOn: '2026-11-10', halfDay: 'am' })).toMatchObject({
			ok: false,
			reason: 'balance'
		});
		// Weekend only: no working days.
		expect(await requestAs(db, user, { startOn: '2026-11-14', endOn: '2026-11-15' })).toMatchObject(
			{
				ok: false,
				reason: 'no_work_days'
			}
		);
		// Public holiday only (Wed 4 Nov): no working days.
		expect(await requestAs(db, user, { startOn: '2026-11-04' })).toMatchObject({
			ok: false,
			reason: 'no_work_days'
		});

		// Approve r1 as HR: usage -8 once.
		if (!r1.ok || !r2.ok) throw new Error('setup');
		const ok = await decide(
			db,
			hr,
			r1.id,
			'approve',
			'',
			(await requestRow(db, r1.id))!.updatedAt,
			t
		);
		expect(ok.ok).toBe(true);
		b = (await balancesFor(db, [emp], 2026))[0]!;
		expect(b).toMatchObject({ entitled: 10, used: 8, pending: 2, available: 0 });

		// Cancel r2 (pending): releases 2.
		const c2 = await getRequest(db, r2.id);
		expect(
			(
				await cancel(
					db,
					{ userId: user.id, ownEmployeeId: emp },
					c2!,
					false,
					c2!.updatedAt,
					'2026-10-26',
					t
				)
			).ok
		).toBe(true);
		b = (await balancesFor(db, [emp], 2026))[0]!;
		expect(b).toMatchObject({ used: 8, pending: 0, available: 2 });

		// Half day (am) on Tue 10 Nov = 1 half-day -> available 1.
		const r3 = await requestAs(db, user, { startOn: '2026-11-10', halfDay: 'am' });
		expect(r3).toMatchObject({ ok: true, halfDays: 1 });
		// pm on the same date does not overlap am; a full day overlaps.
		expect(await requestAs(db, user, { startOn: '2026-11-10', halfDay: 'pm' })).toMatchObject({
			ok: true
		});
		expect(await requestAs(db, user, { startOn: '2026-11-10' })).toMatchObject({
			ok: false,
			reason: 'overlap'
		});

		// Cancel the APPROVED r1 before it starts: reversal +8 once, double cancel idempotent.
		const c1 = await getRequest(db, r1.id);
		const first = await cancel(
			db,
			{ userId: user.id, ownEmployeeId: emp },
			c1!,
			false,
			c1!.updatedAt,
			'2026-10-26',
			t + 1
		);
		expect(first.ok).toBe(true);
		const again = await getRequest(db, r1.id);
		expect(
			(
				await cancel(
					db,
					{ userId: user.id, ownEmployeeId: emp },
					again!,
					false,
					again!.updatedAt,
					'2026-10-26',
					t + 2
				)
			).ok
		).toBe(true);
		const ledger = await ledgerRows(db, emp);
		expect(ledger.filter((l) => l.kind === 'reversal')).toHaveLength(1);
		expect(ledger.reduce((s, l) => s + l.halfDays, 0)).toBe(10); // grant 10, usage -8, reversal +8
		b = (await balancesFor(db, [emp], 2026))[0]!;
		// 2 pending half-days (am + pm of 10 Nov); entitled 10 -> available 8.
		expect(b).toMatchObject({ entitled: 10, used: 0, pending: 2, available: 8 });

		// Deducting holiday Wed 11 Nov counts as a leave day (2 half-days).
		expect(await requestAs(db, user, { startOn: '2026-11-11' })).toMatchObject({
			ok: true,
			halfDays: 2
		});

		// Year boundary at repo level: Sick Thu 31 Dec - Fri 1 Jan = 4 half-days, period 2026, no ledger row.
		const sick = await requestAs(db, user, {
			typeId: 'lt_sick',
			startOn: '2026-12-31',
			endOn: '2027-01-01'
		});
		expect(sick).toMatchObject({ ok: true, halfDays: 4 });
		// 1 Jan 2027 balance request uses the 2027 grant (full 24 for a 2026 joiner).
		const r4 = await requestAs(db, user, { startOn: '2027-01-04', endOn: '2027-01-04' });
		expect(r4).toMatchObject({ ok: true, halfDays: 2 });
		const b27 = (await balancesFor(db, [emp], 2027))[0]!;
		expect(b27).toMatchObject({ entitled: 24, pending: 2, available: 22 });
	});
});
