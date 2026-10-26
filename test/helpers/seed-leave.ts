import type { SessionUser } from '#lib/server/auth/session';
import type { Db } from '#lib/server/db';
import { loadViewer } from '#lib/server/hr/access';
import { addDays, countHalfDays, isoWeekday, yearOf } from '#lib/server/timeoff/calendar';
import { requestLeave } from '#lib/server/timeoff/repo';
import { grantHr, hrWorld, seedEmployee } from './seed-hr';
import { insertUser } from './users';

/**
 * RB-06 fixtures on top of RB-05's `hrWorld` (fictional people only): every leave test gets its own cast, so tests
 * in one file never share balances. Dates are relative to the real team date: `planBase` finds a Monday from
 * which `days` calendar days stay in one year and within the 366-day request window.
 */

export function planBase(today: string, days = 130): string {
	for (let i = 7; i < 240; i += 1) {
		const d = addDays(today, i);
		if (isoWeekday(d) === 1 && yearOf(d) === yearOf(addDays(d, days))) return d;
	}
	throw new Error('no base date');
}

/** Consecutive ranges from `start`, each covering exactly `halfDays` on Monday–Friday without holidays. */
export function rangesOf(start: string, halfDays: number, n: number) {
	const out: { startOn: string; endOn: string }[] = [];
	let from = start;
	while (out.length < n) {
		while (isoWeekday(from) > 5) from = addDays(from, 1);
		let to = from;
		while (
			countHalfDays({
				startOn: from,
				endOn: to,
				halfDay: 'none',
				workDays: [1, 2, 3, 4, 5],
				holidays: []
			}).halfDays < halfDays
		)
			to = addDays(to, 1);
		out.push({ startOn: from, endOn: to });
		from = addDays(to, 1);
	}
	return out;
}

/** hrWorld plus: the HR user's own employee (no manager), a second HR user, and a manager-less employee. */
export async function leaveWorld(db: Db) {
	const world = await hrWorld(db);
	const hr2 = await insertUser(db, { name: `Second HR ${world.tag}` });
	await grantHr(db, hr2.id);
	const loner = await insertUser(db, { name: `Loner ${world.tag}` });
	const hrEmployee = await seedEmployee(
		db,
		world.users.hr.id,
		{ fullName: `HR Person ${world.tag}`, startOn: '2023-01-02' },
		world.users.hr.id
	);
	const lonerEmployee = await seedEmployee(
		db,
		world.users.hr.id,
		{ fullName: `Loner Person ${world.tag}`, startOn: '2023-01-02', department: world.department },
		loner.id
	);
	return {
		...world,
		users: { ...world.users, hr2, loner },
		employees: { ...world.employees, hr: hrEmployee, loner: lonerEmployee }
	};
}

/** A request through the repo as `user` for their own employee. */
export async function requestAs(
	db: Db,
	user: SessionUser,
	input: {
		typeId?: string;
		startOn: string;
		endOn?: string;
		halfDay?: 'none' | 'am' | 'pm';
		reason?: string;
		kind?: 'balance' | 'logged';
	},
	now = Date.now()
) {
	const viewer = await loadViewer(db, user);
	if (!viewer.ownEmployeeId) throw new Error('user has no employee');
	const typeId = input.typeId ?? 'lt_annual';
	return requestLeave(
		db,
		{ userId: user.id, employeeId: viewer.ownEmployeeId },
		{
			typeId,
			startOn: input.startOn,
			endOn: input.endOn ?? input.startOn,
			halfDay: input.halfDay ?? 'none',
			reason: input.reason ?? '',
			period: yearOf(input.startOn),
			kind: input.kind ?? (typeId === 'lt_annual' ? 'balance' : 'logged')
		},
		now
	);
}

/** The ledger of one employee, oldest first. */
export async function ledgerRows(db: Db, employeeId: string) {
	const { results } = await db.$client
		.prepare(
			`SELECT kind, half_days AS halfDays, period, request_id AS requestId FROM leave_ledger
			 WHERE employee_id = ?1 ORDER BY created_at, rowid`
		)
		.bind(employeeId)
		.all<{ kind: string; halfDays: number; period: number; requestId: string | null }>();
	return results;
}

export async function requestRow(db: Db, id: string) {
	return db.$client
		.prepare(
			`SELECT status, half_days AS halfDays, decided_by AS decidedBy, decision_note AS decisionNote,
				updated_at AS updatedAt FROM leave_requests WHERE id = ?1`
		)
		.bind(id)
		.first<{
			status: string;
			halfDays: number;
			decidedBy: string | null;
			decisionNote: string;
			updatedAt: number;
		}>();
}
