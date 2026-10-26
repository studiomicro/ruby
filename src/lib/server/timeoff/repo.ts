import type { HalfDayPart, LeaveKind, LeaveStatus } from '#lib/shared/enums';
import type { Db } from '../db';
import { auditStatement } from '../hr/audit';
import type { Viewer } from '../hr/visibility';
import { isUniqueViolation, newId } from '../util';
import { annualEntitlement } from './accrual';
import {
	countHalfDays,
	dateOf,
	dayKind,
	dayNumber,
	holidayMap,
	monthRange,
	monthWeeks,
	yearOf,
	type CountResult,
	type HolidayDay
} from './calendar';
import { canDecide, isOverrideDecision, isSelfDecision, type DecideContext } from './permissions';
import { teamToday } from '../tasks/today';
import {
	LEAVE_LIMITS,
	readWorkDays,
	type LeaveTypeInfo,
	type RequestInput,
	type TypeInput
} from './validation';

/**
 * RB-06 data access over raw, parameterised D1 statements. Every state-dependent write is one guarded statement
 * (`INSERT … SELECT … WHERE`, `UPDATE … WHERE status = … AND updated_at = …`) in one `db.batch` with what must go
 * with it (ledger entry, audit row), so two requests, two approvals or two cancels can never both pass a check
 * that only one of them should. Balances are integer half-days, the sum of `leave_ledger` entries.
 */

const GRANT_BATCH = 50;

// ── Settings: work days, types, holidays ───────────────────────────────────────────────────────────────────

export async function getWorkDays(db: Db): Promise<{ days: number[]; updatedAt: number }> {
	const row = await db.$client
		.prepare(`SELECT value, updated_at AS updatedAt FROM app_meta WHERE key = 'work_days'`)
		.first<{ value: string; updatedAt: number }>();
	return { days: readWorkDays(row?.value), updatedAt: row?.updatedAt ?? 0 };
}

export interface LeaveTypeRow extends LeaveTypeInfo {
	name: string;
	annualHalfDays: number;
	sort: number;
	updatedAt: number;
}

export async function listTypes(db: Db, activeOnly = false): Promise<LeaveTypeRow[]> {
	const { results } = await db.$client
		.prepare(
			`SELECT id, name, kind, annual_half_days AS annualHalfDays, requires_reason AS requiresReason,
				active, sort, updated_at AS updatedAt
			 FROM leave_types ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort, lower(name) LIMIT ?1`
		)
		.bind(LEAVE_LIMITS.typesMax + 5)
		.all<
			Omit<LeaveTypeRow, 'requiresReason' | 'active'> & { requiresReason: number; active: number }
		>();
	return results.map((r) => ({
		...r,
		requiresReason: r.requiresReason === 1,
		active: r.active === 1
	}));
}

export interface HolidayRow extends HolidayDay {
	id: string;
	name: string;
}

/** Live holidays between two dates inclusive (at most a year's worth for a request, a few years for settings). */
export async function listHolidays(db: Db, from: string, to: string): Promise<HolidayRow[]> {
	const { results } = await db.$client
		.prepare(
			`SELECT id, on_date AS onDate, name, deducts_leave AS deductsLeave FROM holidays
			 WHERE deleted_at IS NULL AND on_date BETWEEN ?1 AND ?2 ORDER BY on_date LIMIT 500`
		)
		.bind(from, to)
		.all<Omit<HolidayRow, 'deductsLeave'> & { deductsLeave: number }>();
	return results.map((r) => ({ ...r, deductsLeave: r.deductsLeave === 1 }));
}

/** Half-days of a range with the stored holidays and work days. */
export async function countRange(
	db: Db,
	range: { startOn: string; endOn: string; halfDay: HalfDayPart }
): Promise<CountResult> {
	const [{ days }, holidays] = await Promise.all([
		getWorkDays(db),
		listHolidays(db, range.startOn, range.endOn)
	]);
	return countHalfDays({ ...range, workDays: days, holidays });
}

export type SettingsWrite =
	{ ok: true } | { ok: false; reason: 'not_found' | 'changed' | 'full' | 'duplicate' };

export async function saveWorkDays(
	db: Db,
	actorId: string,
	days: readonly number[],
	expected: number,
	now: number
): Promise<SettingsWrite> {
	const update = db.$client
		.prepare(
			`UPDATE app_meta SET value = ?1, updated_at = ?2 WHERE key = 'work_days' AND updated_at = ?3`
		)
		.bind(days.join(','), Math.max(now, expected + 1), expected);
	const audit = auditStatement(db, {
		actorId,
		action: 'work_days_update',
		fields: ['work_days'],
		at: now
	});
	const [written] = await db.$client.batch([update, audit]);
	return written?.meta.changes === 1 ? { ok: true } : { ok: false, reason: 'changed' };
}

export async function createType(
	db: Db,
	actorId: string,
	input: TypeInput,
	now: number
): Promise<SettingsWrite> {
	const insert = db.$client
		.prepare(
			`INSERT INTO leave_types (id, name, kind, annual_half_days, requires_reason, active, sort, created_at,
				updated_at)
			 SELECT ?1, ?2, ?3, ?4, ?5, 1, (SELECT coalesce(max(sort), 0) + 1 FROM leave_types), ?6, ?6
			 WHERE (SELECT count(*) FROM leave_types) < ?7`
		)
		.bind(
			newId(),
			input.name,
			input.kind,
			input.kind === 'balance' ? input.annualHalfDays : 0,
			input.requiresReason ? 1 : 0,
			now,
			LEAVE_LIMITS.typesMax
		);
	const audit = auditStatement(db, {
		actorId,
		action: 'leave_type_update',
		fields: ['name', 'kind', 'annual_half_days', 'requires_reason'],
		at: now
	});
	try {
		const [written] = await db.$client.batch([insert, audit]);
		return written?.meta.changes === 1 ? { ok: true } : { ok: false, reason: 'full' };
	} catch (e) {
		if (isUniqueViolation(e)) return { ok: false, reason: 'duplicate' };
		throw e;
	}
}

export async function updateType(
	db: Db,
	actorId: string,
	current: LeaveTypeRow,
	input: TypeInput,
	expected: number,
	now: number
): Promise<SettingsWrite> {
	const annual = current.kind === 'balance' ? input.annualHalfDays : 0;
	const changed = [
		input.name !== current.name ? 'name' : null,
		annual !== current.annualHalfDays ? 'annual_half_days' : null,
		input.requiresReason !== current.requiresReason ? 'requires_reason' : null,
		input.active !== current.active ? 'active' : null
	].filter((f): f is string => f !== null);
	if (changed.length === 0)
		return current.updatedAt === expected ? { ok: true } : { ok: false, reason: 'changed' };
	const update = db.$client
		.prepare(
			`UPDATE leave_types SET name = ?1, annual_half_days = ?2, requires_reason = ?3, active = ?4, updated_at = ?5
			 WHERE id = ?6 AND updated_at = ?7`
		)
		.bind(
			input.name,
			annual,
			input.requiresReason ? 1 : 0,
			input.active ? 1 : 0,
			Math.max(now, expected + 1),
			current.id,
			expected
		);
	const audit = auditStatement(db, {
		actorId,
		action: 'leave_type_update',
		fields: changed,
		at: now
	});
	try {
		const [written] = await db.$client.batch([update, audit]);
		return written?.meta.changes === 1 ? { ok: true } : { ok: false, reason: 'changed' };
	} catch (e) {
		if (isUniqueViolation(e)) return { ok: false, reason: 'duplicate' };
		throw e;
	}
}

/** A holiday on a date without a live one, at most LEAVE_LIMITS.holidaysPerYear live per year. */
export async function addHoliday(
	db: Db,
	actorId: string,
	input: { onDate: string; name: string; deductsLeave: boolean },
	now: number
): Promise<SettingsWrite> {
	const year = input.onDate.slice(0, 4);
	const insert = db.$client
		.prepare(
			`INSERT INTO holidays (id, on_date, name, deducts_leave, created_by, created_at, updated_at)
			 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6
			 WHERE (SELECT count(*) FROM holidays WHERE deleted_at IS NULL AND on_date BETWEEN ?7 AND ?8) < ?9`
		)
		.bind(
			newId(),
			input.onDate,
			input.name,
			input.deductsLeave ? 1 : 0,
			actorId,
			now,
			`${year}-01-01`,
			`${year}-12-31`,
			LEAVE_LIMITS.holidaysPerYear
		);
	const audit = auditStatement(db, {
		actorId,
		action: 'holiday_update',
		fields: ['on_date', 'name', 'deducts_leave'],
		detail: year,
		at: now
	});
	try {
		const [written] = await db.$client.batch([insert, audit]);
		return written?.meta.changes === 1 ? { ok: true } : { ok: false, reason: 'full' };
	} catch (e) {
		if (isUniqueViolation(e)) return { ok: false, reason: 'duplicate' };
		throw e;
	}
}

/** Soft-deletes a holiday; deleting one already deleted is a no-op success. Stored request days do not change. */
export async function deleteHoliday(
	db: Db,
	actorId: string,
	id: string,
	now: number
): Promise<SettingsWrite> {
	const update = db.$client
		.prepare(
			`UPDATE holidays SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL`
		)
		.bind(now, id);
	const audit = auditStatement(db, {
		actorId,
		action: 'holiday_update',
		fields: ['deleted_at'],
		at: now
	});
	const [written] = await db.$client.batch([update, audit]);
	if (written?.meta.changes === 1) return { ok: true };
	const row = await db.$client
		.prepare('SELECT 1 AS x FROM holidays WHERE id = ?1')
		.bind(id)
		.first();
	return row ? { ok: true } : { ok: false, reason: 'not_found' };
}

// ── Ledger: grants, balances, adjustments ──────────────────────────────────────────────────────────────────

const LEDGER_SUM = (e: string, t: string, p: string) =>
	`(SELECT coalesce(sum(l.half_days), 0) FROM leave_ledger l WHERE l.employee_id = ${e} AND l.type_id = ${t}
		AND l.period = ${p})`;
const PENDING_SUM = (e: string, t: string, p: string, exclude = 'NULL') =>
	`(SELECT coalesce(sum(q.half_days), 0) FROM leave_requests q WHERE q.employee_id = ${e} AND q.type_id = ${t}
		AND q.period = ${p} AND q.status = 'pending' AND q.id IS NOT ${exclude})`;

/**
 * The yearly grant of every active balance type for `employeeIds` (live, active, with a start date) and `period`,
 * written once: `INSERT OR IGNORE … WHERE NOT EXISTS` plus the partial unique index `leave_ledger_grant_uq`, so
 * concurrent calls add exactly one grant. Batches of at most GRANT_BATCH statements. Returns the rows written.
 */
export async function ensureGrants(
	db: Db,
	employeeIds: readonly string[],
	period: number,
	actorId: string,
	now: number
): Promise<number> {
	if (employeeIds.length === 0) return 0;
	const [{ results: people }, types] = await Promise.all([
		db.$client
			.prepare(
				`SELECT e.id AS id, e.start_on AS startOn FROM employees e
				 WHERE e.id IN (SELECT value FROM json_each(?1)) AND e.deleted_at IS NULL AND e.status = 'active'
					AND e.start_on IS NOT NULL`
			)
			.bind(JSON.stringify(employeeIds))
			.all<{ id: string; startOn: string }>(),
		listTypes(db, true)
	]);
	const statements: D1PreparedStatement[] = [];
	for (const type of types) {
		if (type.kind !== 'balance' || type.annualHalfDays <= 0) continue;
		for (const person of people) {
			const amount = annualEntitlement({
				startOn: person.startOn,
				period,
				annualHalfDays: type.annualHalfDays
			});
			if (amount <= 0) continue;
			statements.push(
				db.$client
					.prepare(
						`INSERT OR IGNORE INTO leave_ledger (id, employee_id, type_id, period, half_days, kind, request_id,
							note, created_by, created_at)
						 SELECT ?1, ?2, ?3, ?4, ?5, 'grant', NULL, '', ?6, ?7
						 WHERE NOT EXISTS (SELECT 1 FROM leave_ledger WHERE employee_id = ?2 AND type_id = ?3
							AND period = ?4 AND kind = 'grant')`
					)
					.bind(newId(), person.id, type.id, period, amount, actorId, now)
			);
		}
	}
	let written = 0;
	for (let i = 0; i < statements.length; i += GRANT_BATCH) {
		const results = await db.$client.batch(statements.slice(i, i + GRANT_BATCH));
		written += results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
	}
	return written;
}

/**
 * The grant written on the side of a write action (request, decide, adjust): never on a GET (red team L6), and never
 * for a year before the current one (QA D4): past years are granted only by HR's explicit "Grant {year}".
 */
async function lazyGrants(
	db: Db,
	employeeIds: readonly string[],
	period: number,
	actorId: string,
	now: number
): Promise<number> {
	if (period < yearOf(teamToday(now))) return 0;
	return ensureGrants(db, employeeIds, period, actorId, now);
}

/** HR's "Grant {year}": the same idempotent grant for every live, active employee with a start date. */
export async function grantYear(
	db: Db,
	actorId: string,
	period: number,
	now: number
): Promise<number> {
	const { results } = await db.$client
		.prepare(
			`SELECT id FROM employees WHERE deleted_at IS NULL AND status = 'active' AND start_on IS NOT NULL
			 ORDER BY id LIMIT 1000`
		)
		.all<{ id: string }>();
	return ensureGrants(
		db,
		results.map((r) => r.id),
		period,
		actorId,
		now
	);
}

export interface Balance {
	employeeId: string;
	typeId: string;
	typeName: string;
	/** Grants plus adjustments. */
	entitled: number;
	/** Approved usage minus reversals. */
	used: number;
	pending: number;
	available: number;
}

/**
 * Balances of every active balance type for `employeeIds` in `period` (computed in SQL, one row per pair). Read
 * only: where the yearly grant is not written yet, the entitlement the lazy grant would write is added in memory,
 * so a page load never writes to the ledger (red team L6).
 */
export async function balancesFor(
	db: Db,
	employeeIds: readonly string[],
	period: number
): Promise<Balance[]> {
	if (employeeIds.length === 0) return [];
	const lazyYear = period >= yearOf(teamToday());
	const { results } = await db.$client
		.prepare(
			`SELECT e.value AS employeeId, t.id AS typeId, t.name AS typeName, t.annual_half_days AS annual,
				EXISTS (SELECT 1 FROM leave_ledger g WHERE g.employee_id = e.value AND g.type_id = t.id
					AND g.period = ?2 AND g.kind = 'grant') AS granted,
				(SELECT p.start_on FROM employees p WHERE p.id = e.value AND p.deleted_at IS NULL
					AND p.status = 'active') AS startOn,
				(SELECT coalesce(sum(l.half_days), 0) FROM leave_ledger l WHERE l.employee_id = e.value
					AND l.type_id = t.id AND l.period = ?2 AND l.kind IN ('grant', 'adjustment')) AS entitled,
				(SELECT coalesce(-sum(l.half_days), 0) FROM leave_ledger l WHERE l.employee_id = e.value
					AND l.type_id = t.id AND l.period = ?2 AND l.kind IN ('usage', 'reversal')) AS used,
				${PENDING_SUM('e.value', 't.id', '?2')} AS pending
			 FROM json_each(?1) e CROSS JOIN leave_types t
			 WHERE t.kind = 'balance' AND t.active = 1
			 ORDER BY t.sort, lower(t.name)`
		)
		.bind(JSON.stringify(employeeIds), period)
		.all<
			Omit<Balance, 'available'> & { annual: number; granted: number; startOn: string | null }
		>();
	return results.map(({ annual, granted, startOn, ...r }) => {
		const pendingGrant =
			lazyYear && !granted ? annualEntitlement({ startOn, period, annualHalfDays: annual }) : 0;
		const entitled = r.entitled + pendingGrant;
		return { ...r, entitled, available: entitled - r.used - r.pending };
	});
}

export type AdjustWrite =
	{ ok: true } | { ok: false; reason: 'not_found' | 'below_zero'; available?: number };

/**
 * HR's signed adjustment of one balance (carry-over, correction) with its `leave_adjust` audit row, atomically.
 * A negative adjustment that would take the available balance below zero writes nothing.
 */
export async function adjust(
	db: Db,
	actor: Pick<Viewer, 'userId' | 'ownEmployeeId'>,
	input: { employeeId: string; typeId: string; period: number; halfDays: number; note: string },
	now: number
): Promise<AdjustWrite> {
	const actorId = actor.userId;
	// HR adjusting their own balance stays allowed (red team L2) but the audit row is flagged `self`.
	const self = actor.ownEmployeeId !== null && actor.ownEmployeeId === input.employeeId;
	await lazyGrants(db, [input.employeeId], input.period, actorId, now);
	const insert = db.$client
		.prepare(
			`INSERT INTO leave_ledger (id, employee_id, type_id, period, half_days, kind, request_id, note, created_by,
				created_at)
			 SELECT ?1, ?2, ?3, ?4, ?5, 'adjustment', NULL, ?6, ?7, ?8
			 WHERE EXISTS (SELECT 1 FROM employees e WHERE e.id = ?2 AND e.deleted_at IS NULL)
				AND EXISTS (SELECT 1 FROM leave_types t WHERE t.id = ?3 AND t.kind = 'balance')
				AND (?5 > 0 OR ${LEDGER_SUM('?2', '?3', '?4')} - ${PENDING_SUM('?2', '?3', '?4')} + ?5 >= 0)`
		)
		.bind(
			newId(),
			input.employeeId,
			input.typeId,
			input.period,
			input.halfDays,
			input.note,
			actorId,
			now
		);
	const audit = auditStatement(db, {
		actorId,
		action: 'leave_adjust',
		employeeId: input.employeeId,
		userId: self ? actorId : null,
		fields: ['half_days'],
		detail: self ? `${input.period} · self` : String(input.period),
		at: now
	});
	const [written] = await db.$client.batch([insert, audit]);
	if (written?.meta.changes === 1) return { ok: true };
	const check = await db.$client
		.prepare(
			`SELECT EXISTS (SELECT 1 FROM employees e WHERE e.id = ?1 AND e.deleted_at IS NULL) AS employee,
				EXISTS (SELECT 1 FROM leave_types t WHERE t.id = ?2 AND t.kind = 'balance') AS type,
				${LEDGER_SUM('?1', '?2', '?3')} - ${PENDING_SUM('?1', '?2', '?3')} AS available`
		)
		.bind(input.employeeId, input.typeId, input.period)
		.first<{ employee: number; type: number; available: number }>();
	if (!check?.employee || !check.type) return { ok: false, reason: 'not_found' };
	return { ok: false, reason: 'below_zero', available: check.available };
}

// ── Requests ───────────────────────────────────────────────────────────────────────────────────────────────

export interface RequestRow {
	id: string;
	employeeId: string;
	employeeName: string;
	typeId: string;
	typeName: string;
	kind: LeaveKind;
	startOn: string;
	endOn: string;
	halfDay: HalfDayPart;
	halfDays: number;
	period: number;
	reason: string;
	status: LeaveStatus;
	decidedByName: string | null;
	decidedAt: number | null;
	decisionNote: string;
	/** 1 when the requester approved it themselves (no other approver existed). */
	selfApproved: number;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}

const REQUEST_SELECT = `SELECT r.id AS id, r.employee_id AS employeeId, e.full_name AS employeeName,
	r.type_id AS typeId, t.name AS typeName, t.kind AS kind, r.start_on AS startOn, r.end_on AS endOn,
	r.half_day AS halfDay, r.half_days AS halfDays, r.period AS period, r.reason AS reason, r.status AS status,
	d.name AS decidedByName, r.decided_at AS decidedAt, r.decision_note AS decisionNote,
	r.self_approved AS selfApproved, r.created_by AS createdBy, r.created_at AS createdAt, r.updated_at AS updatedAt
	FROM leave_requests r
	JOIN leave_types t ON t.id = r.type_id
	JOIN employees e ON e.id = r.employee_id
	LEFT JOIN users d ON d.id = r.decided_by`;

/** The live, active direct manager's active account of employee `e`, as a join. */
const MANAGER_JOIN = `LEFT JOIN employees m ON m.id = e.manager_id AND m.deleted_at IS NULL AND m.status = 'active'
		AND m.id <> e.id
	LEFT JOIN users mu ON mu.id = m.user_id AND mu.status = 'active'`;
/** An active HR user other than the requester of request `req` (a table alias) exists. */
const OTHER_HR = (req: string) =>
	`EXISTS (SELECT 1 FROM users h WHERE h.is_hr = 1 AND h.status = 'active' AND h.id <> ${req}.created_by)`;
/** An active admin other than the requester of request `req` exists. */
const OTHER_ADMIN = (req: string) =>
	`EXISTS (SELECT 1 FROM users ad WHERE ad.role = 'admin' AND ad.status = 'active' AND ad.id <> ${req}.created_by)`;

/**
 * `canDecide` in SQL: actor `actor` (a parameter; its row joined as `a`, active) may decide request `req` of
 * employee `e` (with MANAGER_JOIN's `mu`). Someone other than the requester: the manager's account, any HR, or an
 * admin when there is no manager account and no other HR. The requester: only while they are also the linked
 * account and there is no manager account, no other active HR user and no other active admin (owner decision 10
 * addendum; audited self-approval).
 */
const MAY_DECIDE = (req: string, actor: string) => `(
	(${req}.created_by <> ${actor} AND (e.user_id IS NULL OR e.user_id <> ${actor})
		AND (mu.id = ${actor} OR a.is_hr = 1 OR (a.role = 'admin' AND mu.id IS NULL AND NOT ${OTHER_HR(req)})))
	OR (${req}.created_by = ${actor} AND e.user_id = ${actor} AND mu.id IS NULL AND NOT ${OTHER_HR(req)}
		AND NOT ${OTHER_ADMIN(req)}))`;

export interface RequestContext extends RequestRow {
	decide: DecideContext;
	employeeLive: boolean;
}

/** One request with everything an authorization check needs, re-read from D1; null when missing. */
export async function getRequest(db: Db, id: string): Promise<RequestContext | null> {
	const row = await db.$client
		.prepare(
			`${REQUEST_SELECT.replace(
				'FROM leave_requests r',
				`, e.user_id AS employeeUserId, mu.id AS managerUserId,
				${OTHER_HR('r')} AS otherHr, ${OTHER_ADMIN('r')} AS otherAdmin,
				(e.deleted_at IS NULL AND e.status = 'active') AS employeeLive FROM leave_requests r`
			)}
			 ${MANAGER_JOIN}
			 WHERE r.id = ?1`
		)
		.bind(id)
		.first<
			RequestRow & {
				employeeUserId: string | null;
				managerUserId: string | null;
				otherHr: number;
				otherAdmin: number;
				employeeLive: number;
			}
		>();
	if (!row) return null;
	const { employeeUserId, managerUserId, otherHr, otherAdmin, employeeLive, ...rest } = row;
	return {
		...rest,
		employeeLive: employeeLive === 1,
		decide: {
			requesterUserId: row.createdBy,
			employeeUserId,
			managerUserId,
			otherHrExists: otherHr === 1,
			otherAdminExists: otherAdmin === 1
		}
	};
}

/**
 * Whether the viewer may approve their own leave (owner decision 10 addendum): their employee has no manager account
 * and no other active HR user and no other active admin exists. Audited; switches off as soon as one exists.
 */
export async function selfApprovalOpen(db: Db, viewer: Viewer): Promise<boolean> {
	if (!viewer.ownEmployeeId) return false;
	const row = await db.$client
		.prepare(
			`SELECT 1 AS x FROM employees e ${MANAGER_JOIN}
			 WHERE e.id = ?1 AND e.user_id = ?2 AND e.deleted_at IS NULL AND e.status = 'active' AND mu.id IS NULL
				AND NOT EXISTS (SELECT 1 FROM users h WHERE h.is_hr = 1 AND h.status = 'active' AND h.id <> ?2)
				AND NOT EXISTS (SELECT 1 FROM users ad WHERE ad.role = 'admin' AND ad.status = 'active' AND ad.id <> ?2)`
		)
		.bind(viewer.ownEmployeeId, viewer.userId)
		.first();
	return row !== null;
}

export async function listEmployeeRequests(
	db: Db,
	employeeId: string,
	limit: number = LEAVE_LIMITS.listMax
): Promise<RequestRow[]> {
	const { results } = await db.$client
		.prepare(
			`${REQUEST_SELECT} WHERE r.employee_id = ?1 ORDER BY r.start_on DESC, r.created_at DESC LIMIT ?2`
		)
		.bind(employeeId, limit)
		.all<RequestRow>();
	return results;
}

export type RequestWrite =
	| { ok: true; id: string; halfDays: number }
	| {
			ok: false;
			reason: 'no_work_days' | 'overlap' | 'pending_max' | 'balance' | 'not_found' | 'before_start';
			available?: number;
			halfDays?: number;
	  };

/**
 * A new pending request of the viewer's own employee, in ONE guarded INSERT (PRD › Concurrency): no overlap with
 * the employee's pending or approved ranges (a morning and an afternoon of the same date do not overlap), fewer
 * than LEAVE_LIMITS.pendingMax pending, and for a balance type ledger sum minus pending at least `half_days`. Two
 * simultaneous requests that together exceed the balance: the second sees the first as pending and fails.
 */
export async function requestLeave(
	db: Db,
	actor: { userId: string; employeeId: string },
	input: RequestInput,
	now: number
): Promise<RequestWrite> {
	const counted = await countRange(db, input);
	if (counted.halfDays < 1) return { ok: false, reason: 'no_work_days' };
	if (input.kind === 'balance')
		await lazyGrants(db, [actor.employeeId], input.period, actor.userId, now);
	const id = newId();
	// Leave cannot start before the employee does (red team L4).
	const started = `NOT EXISTS (SELECT 1 FROM employees s WHERE s.id = ?2 AND s.start_on > ?4)`;
	const overlap = `EXISTS (SELECT 1 FROM leave_requests o WHERE o.employee_id = ?2
		AND o.status IN ('pending', 'approved') AND o.start_on <= ?5 AND o.end_on >= ?4
		AND NOT (o.start_on = o.end_on AND ?4 = ?5 AND o.half_day <> 'none' AND ?6 <> 'none' AND o.half_day <> ?6))`;
	const pendingCount = `(SELECT count(*) FROM leave_requests c WHERE c.employee_id = ?2 AND c.status = 'pending')`;
	const available = `${LEDGER_SUM('?2', '?3', '?8')} - ${PENDING_SUM('?2', '?3', '?8')}`;
	const written = await db.$client
		.prepare(
			`INSERT INTO leave_requests (id, employee_id, type_id, start_on, end_on, half_day, half_days, period, reason,
				status, decision_note, created_by, created_at, updated_at)
			 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', '', ?10, ?11, ?11
			 WHERE EXISTS (SELECT 1 FROM employees e WHERE e.id = ?2 AND e.deleted_at IS NULL AND e.status = 'active'
					AND e.user_id = ?10)
				AND EXISTS (SELECT 1 FROM leave_types t WHERE t.id = ?3 AND t.active = 1 AND t.kind = ?12)
				AND ${started}
				AND NOT ${overlap}
				AND ${pendingCount} < ?13
				AND (?12 = 'logged' OR ${available} >= ?7)`
		)
		.bind(
			id,
			actor.employeeId,
			input.typeId,
			input.startOn,
			input.endOn,
			input.halfDay,
			counted.halfDays,
			input.period,
			input.reason,
			actor.userId,
			now,
			input.kind,
			LEAVE_LIMITS.pendingMax
		)
		.run();
	if (written.meta.changes === 1) return { ok: true, id, halfDays: counted.halfDays };
	const why = await db.$client
		.prepare(
			`SELECT EXISTS (SELECT 1 FROM employees e WHERE e.id = ?2 AND e.deleted_at IS NULL AND e.status = 'active'
					AND e.user_id = ?10) AS employee,
				EXISTS (SELECT 1 FROM leave_types t WHERE t.id = ?3 AND t.active = 1 AND t.kind = ?12) AS type,
				${started} AS started, ${overlap} AS overlap, ${pendingCount} >= ?9 AS pendingFull,
				${available} AS available`
		)
		.bind(
			null,
			actor.employeeId,
			input.typeId,
			input.startOn,
			input.endOn,
			input.halfDay,
			null,
			input.period,
			LEAVE_LIMITS.pendingMax,
			actor.userId,
			null,
			input.kind
		)
		.first<{
			employee: number;
			type: number;
			started: number;
			overlap: number;
			pendingFull: number;
			available: number;
		}>();
	if (!why?.employee || !why.type) return { ok: false, reason: 'not_found' };
	if (!why.started) return { ok: false, reason: 'before_start' };
	if (why.overlap) return { ok: false, reason: 'overlap' };
	if (why.pendingFull) return { ok: false, reason: 'pending_max' };
	return {
		ok: false,
		reason: 'balance',
		available: why.available,
		halfDays: counted.halfDays
	};
}

export type DecideWrite =
	| { ok: true }
	| {
			ok: false;
			reason: 'not_found' | 'decided' | 'changed' | 'balance' | 'no_work_days';
			decidedBy?: string | null;
			available?: number;
			halfDays?: number;
	  };

/**
 * Approve or reject a pending request the actor may decide (else `not_found`, the same answer as a missing id).
 * Approve recomputes the days against today's holidays and work days and, in one batch: the guarded UPDATE
 * (`status = 'pending' AND updated_at = expected` and, for a balance type, enough balance besides this request),
 * the `leave_override` audit row when HR decides in place of the manager, and the `usage` ledger entry written
 * only when the UPDATE took effect (the partial unique index makes a second usage impossible anyway).
 */
export async function decide(
	db: Db,
	actor: Viewer,
	requestId: string,
	decision: 'approve' | 'reject',
	note: string,
	expected: number,
	now: number
): Promise<DecideWrite> {
	const request = await getRequest(db, requestId);
	if (!request || !request.employeeLive || !canDecide(actor, request.decide))
		return { ok: false, reason: 'not_found' };
	if (request.status !== 'pending')
		return { ok: false, reason: 'decided', decidedBy: request.decidedByName };
	const updatedAt = Math.max(now, expected + 1);
	const self = isSelfDecision(actor, request.decide);
	const verb = decision === 'approve' ? 'approved' : 'rejected';
	const audit = self
		? [
				auditStatement(db, {
					actorId: actor.userId,
					// A self-reject is no self-approval (red team I4): its own action.
					action: decision === 'approve' ? 'leave_self_approve' : 'leave_self_reject',
					employeeId: request.employeeId,
					userId: actor.userId,
					fields: ['status'],
					detail: `${verb} · self`,
					at: now
				})
			]
		: isOverrideDecision(actor, request.decide)
			? [
					auditStatement(db, {
						actorId: actor.userId,
						action: 'leave_override',
						employeeId: request.employeeId,
						fields: ['status'],
						detail: verb,
						at: now
					})
				]
			: [];
	// The approver rule again inside the guarded UPDATE (red team L5): a manager change, an HR revoke or a second
	// approver appearing between the read above and the batch makes it write nothing.
	const authorized = `EXISTS (SELECT 1 FROM employees e ${MANAGER_JOIN}
		JOIN users a ON a.id = ?2 AND a.status = 'active'
		WHERE e.id = leave_requests.employee_id AND e.deleted_at IS NULL AND e.status = 'active'
			AND ${MAY_DECIDE('leave_requests', '?2')})`;
	let halfDays = request.halfDays;
	const statements: D1PreparedStatement[] = [];
	if (decision === 'approve') {
		halfDays = (await countRange(db, request)).halfDays;
		if (halfDays < 1) return { ok: false, reason: 'no_work_days' };
		if (request.kind === 'balance')
			await lazyGrants(db, [request.employeeId], request.period, actor.userId, now);
		statements.push(
			db.$client
				.prepare(
					`UPDATE leave_requests SET status = 'approved', decided_by = ?2, decided_at = ?3, decision_note = ?4,
						half_days = ?5, updated_at = ?6, self_approved = (created_by = ?2)
					 WHERE id = ?1 AND status = 'pending' AND updated_at = ?7 AND ${authorized}
						AND (?8 = 'logged' OR ${LEDGER_SUM('?9', '?10', '?11')} - ${PENDING_SUM('?9', '?10', '?11', '?1')} >= ?5)`
				)
				.bind(
					request.id,
					actor.userId,
					now,
					note,
					halfDays,
					updatedAt,
					expected,
					request.kind,
					request.employeeId,
					request.typeId,
					request.period
				),
			...audit
		);
		if (request.kind === 'balance')
			statements.push(
				db.$client
					.prepare(
						`INSERT INTO leave_ledger (id, employee_id, type_id, period, half_days, kind, request_id, note,
							created_by, created_at)
						 SELECT ?1, ?2, ?3, ?4, ?5, 'usage', ?6, '', ?7, ?8
						 WHERE EXISTS (SELECT 1 FROM leave_requests WHERE id = ?6 AND status = 'approved'
							AND updated_at = ?9)`
					)
					.bind(
						newId(),
						request.employeeId,
						request.typeId,
						request.period,
						-halfDays,
						request.id,
						actor.userId,
						now,
						updatedAt
					)
			);
	} else {
		statements.push(
			db.$client
				.prepare(
					`UPDATE leave_requests SET status = 'rejected', decided_by = ?2, decided_at = ?3, decision_note = ?4,
						updated_at = ?5
					 WHERE id = ?1 AND status = 'pending' AND updated_at = ?6 AND ${authorized}`
				)
				.bind(request.id, actor.userId, now, note, updatedAt, expected),
			...audit
		);
	}
	const [written] = await db.$client.batch(statements);
	if (written?.meta.changes === 1) return { ok: true };
	const current = await getRequest(db, requestId);
	if (!current || !current.employeeLive) return { ok: false, reason: 'not_found' };
	if (current.status !== 'pending')
		return { ok: false, reason: 'decided', decidedBy: current.decidedByName };
	if (current.updatedAt !== expected) return { ok: false, reason: 'changed' };
	// The rule changed under the batch: the actor may no longer decide; the same answer as a missing id.
	if (!canDecide(actor, current.decide)) return { ok: false, reason: 'not_found' };
	const [balance] = (await balancesFor(db, [current.employeeId], current.period)).filter(
		(b) => b.typeId === current.typeId
	);
	return {
		ok: false,
		reason: 'balance',
		available: balance ? balance.available + current.halfDays : 0,
		halfDays
	};
}

export type CancelWrite =
	{ ok: true } | { ok: false; reason: 'not_found' | 'decided' | 'changed' | 'started' };

/**
 * Cancels a pending or approved request (the caller has checked `canCancel`). `override`: HR, which may cancel an
 * approved request after its start and writes a `leave_override` audit row in the same batch. Canceling an approved
 * balance request writes the `reversal` (+ the usage) only when the UPDATE took effect; the partial unique index
 * blocks a second refund. Canceling what is already canceled succeeds without writing.
 */
export async function cancel(
	db: Db,
	actor: Pick<Viewer, 'userId' | 'ownEmployeeId'>,
	request: RequestContext,
	override: boolean,
	expected: number,
	today: string,
	now: number
): Promise<CancelWrite> {
	const actorId = actor.userId;
	const updatedAt = Math.max(now, expected + 1);
	// Re-checked in the guarded UPDATE: an override needs the actor to be active HR now; the requester's own cancel
	// needs the request's employee to be linked to the actor now (red team L3), not when the request was made.
	const allowed = override
		? `EXISTS (SELECT 1 FROM users a WHERE a.id = ?6 AND a.is_hr = 1 AND a.status = 'active')`
		: `EXISTS (SELECT 1 FROM employees e WHERE e.id = leave_requests.employee_id AND e.user_id = ?6
			AND e.deleted_at IS NULL AND e.status = 'active')`;
	const update = db.$client
		.prepare(
			`UPDATE leave_requests SET status = 'canceled', updated_at = ?2
			 WHERE id = ?1 AND updated_at = ?3 AND ${allowed}
				AND (status = 'pending' OR (status = 'approved' AND (?4 = 1 OR start_on > ?5)))`
		)
		.bind(request.id, updatedAt, expected, override ? 1 : 0, today, actorId);
	// HR canceling their own (started) leave stays allowed (red team L2) but is flagged `self` in the audit log.
	const self = actor.ownEmployeeId !== null && actor.ownEmployeeId === request.employeeId;
	const audit = override
		? [
				auditStatement(db, {
					actorId,
					action: 'leave_override',
					employeeId: request.employeeId,
					userId: self ? actorId : null,
					fields: ['status'],
					detail: self ? 'canceled · self' : 'canceled',
					at: now
				})
			]
		: [];
	const reversal = db.$client
		.prepare(
			`INSERT INTO leave_ledger (id, employee_id, type_id, period, half_days, kind, request_id, note, created_by,
				created_at)
			 SELECT ?1, u.employee_id, u.type_id, u.period, -u.half_days, 'reversal', u.request_id, '', ?3, ?4
			 FROM leave_ledger u WHERE u.request_id = ?2 AND u.kind = 'usage'
				AND EXISTS (SELECT 1 FROM leave_requests WHERE id = ?2 AND status = 'canceled' AND updated_at = ?5)`
		)
		.bind(newId(), request.id, actorId, now, updatedAt);
	const [written] = await db.$client.batch([update, ...audit, reversal]);
	if (written?.meta.changes === 1) return { ok: true };
	const current = await getRequest(db, request.id);
	if (!current) return { ok: false, reason: 'not_found' };
	if (current.status === 'canceled') return { ok: true };
	if (current.status !== 'pending' && current.status !== 'approved')
		return { ok: false, reason: 'decided' };
	if (current.updatedAt !== expected) return { ok: false, reason: 'changed' };
	if (current.status === 'approved' && !override && current.startOn <= today)
		return { ok: false, reason: 'started' };
	return { ok: false, reason: 'not_found' };
}

// ── Approval queue, nav badge ──────────────────────────────────────────────────────────────────────────────

/**
 * The pending requests actor `?1` may decide (MAY_DECIDE: `canDecide` in SQL, the requester's own included while
 * self-approval is open). The actor's HR flag and role are read from D1 here, never from the session.
 */
const DECIDABLE = `FROM leave_requests r
	JOIN employees e ON e.id = r.employee_id AND e.deleted_at IS NULL AND e.status = 'active'
	${MANAGER_JOIN}
	JOIN users a ON a.id = ?1 AND a.status = 'active'
	WHERE r.status = 'pending' AND ${MAY_DECIDE('r', '?1')}`;

/** The nav badge: pending requests the viewer may decide, counted up to 100. */
export async function decidableCount(db: Db, userId: string): Promise<number> {
	const row = await db.$client
		.prepare(`SELECT count(*) AS n FROM (SELECT 1 ${DECIDABLE} LIMIT 100)`)
		.bind(userId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export interface QueueRow extends RequestRow {
	department: string | null;
	managerId: string | null;
	/** For a balance type: what remains available after approving this request (stored days). */
	remainingAfter: number | null;
	/** Names of colleagues (same department or same manager) with approved leave overlapping this request. */
	overlaps: string[];
}

export async function listApprovalQueue(db: Db, actor: Viewer): Promise<QueueRow[]> {
	const { results } = await db.$client
		.prepare(
			`SELECT r.id AS id, r.employee_id AS employeeId, e.full_name AS employeeName, r.type_id AS typeId,
					t.name AS typeName, t.kind AS kind, r.start_on AS startOn, r.end_on AS endOn, r.half_day AS halfDay,
					r.half_days AS halfDays, r.period AS period, r.reason AS reason, r.status AS status,
					NULL AS decidedByName, NULL AS decidedAt, r.decision_note AS decisionNote, 0 AS selfApproved,
					r.created_by AS createdBy,
					r.created_at AS createdAt, r.updated_at AS updatedAt, e.department AS department,
					e.manager_id AS managerId,
					CASE WHEN t.kind = 'balance' THEN ${LEDGER_SUM('r.employee_id', 'r.type_id', 'r.period')}
						- ${PENDING_SUM('r.employee_id', 'r.type_id', 'r.period', 'r.id')} END AS remainingAfter
				 ${DECIDABLE.replace('FROM leave_requests r', 'FROM leave_requests r JOIN leave_types t ON t.id = r.type_id')}
				 ORDER BY r.start_on, r.created_at LIMIT ?2`
		)
		.bind(actor.userId, LEAVE_LIMITS.listMax)
		.all<Omit<QueueRow, 'overlaps'>>();
	// A balance request wrote its year's grant when it was made, so "remaining" needs no write here (no GET writes).
	if (results.length === 0) return [];

	const from = results.reduce((m, r) => (r.startOn < m ? r.startOn : m), results[0]!.startOn);
	const to = results.reduce((m, r) => (r.endOn > m ? r.endOn : m), results[0]!.endOn);
	const { results: out } = await db.$client
		.prepare(
			`SELECT r.employee_id AS employeeId, r.start_on AS startOn, r.end_on AS endOn, e.full_name AS name,
				e.department AS department, e.manager_id AS managerId
			 FROM leave_requests r JOIN employees e ON e.id = r.employee_id AND e.deleted_at IS NULL
			 WHERE r.status = 'approved' AND r.start_on <= ?2 AND r.end_on >= ?1 LIMIT 500`
		)
		.bind(from, to)
		.all<{
			employeeId: string;
			startOn: string;
			endOn: string;
			name: string;
			department: string | null;
			managerId: string | null;
		}>();
	return results.map((r) => {
		const names = new Set<string>();
		for (const o of out) {
			if (o.employeeId === r.employeeId || o.startOn > r.endOn || o.endOn < r.startOn) continue;
			const sameTeam =
				(r.department !== null && o.department === r.department) ||
				(r.managerId !== null && o.managerId === r.managerId);
			if (sameTeam) names.add(o.name);
		}
		return {
			...r,
			remainingAfter: r.remainingAfter === null ? null : r.remainingAfter - r.halfDays,
			overlaps: [...names].slice(0, 5)
		};
	});
}

// ── Team, calendar ─────────────────────────────────────────────────────────────────────────────────────────

export interface TeamMember {
	id: string;
	fullName: string;
}

/** HR: every live, active employee; a manager: their live, active direct reports (never skip-level). */
export async function teamMembers(db: Db, viewer: Viewer): Promise<TeamMember[]> {
	if (!viewer.isHr && !viewer.ownEmployeeId) return [];
	const { results } = await db.$client
		.prepare(
			`SELECT id, full_name AS fullName FROM employees
			 WHERE deleted_at IS NULL AND status = 'active' AND (?1 = 1 OR (manager_id = ?2 AND id <> ?2))
			 ORDER BY full_name LIMIT 500`
		)
		.bind(viewer.isHr ? 1 : 0, viewer.ownEmployeeId)
		.all<TeamMember>();
	return results;
}

/** Whether the viewer manages at least one live, active employee. */
export async function hasReports(db: Db, viewer: Viewer): Promise<boolean> {
	if (!viewer.ownEmployeeId) return false;
	const row = await db.$client
		.prepare(
			`SELECT 1 AS x FROM employees WHERE manager_id = ?1 AND id <> ?1 AND deleted_at IS NULL
				AND status = 'active' LIMIT 1`
		)
		.bind(viewer.ownEmployeeId)
		.first();
	return row !== null;
}

export async function listTeamRequests(
	db: Db,
	employeeIds: readonly string[],
	filter: { status: LeaveStatus | null; period: number }
): Promise<RequestRow[]> {
	if (employeeIds.length === 0) return [];
	const { results } = await db.$client
		.prepare(
			`${REQUEST_SELECT}
			 WHERE r.employee_id IN (SELECT value FROM json_each(?1)) AND r.period = ?2 AND (?3 IS NULL OR r.status = ?3)
			 ORDER BY r.start_on DESC, r.created_at DESC LIMIT ?4`
		)
		.bind(JSON.stringify(employeeIds), filter.period, filter.status, LEAVE_LIMITS.listMax)
		.all<RequestRow>();
	return results;
}

export interface CalendarDay {
	date: string;
	holiday: string | null;
	/** Who is out: names and the part of the day only (never the type, reason or status). */
	out: { name: string; part: HalfDayPart }[];
}

/**
 * The month grid of approved leave for every user. Only names and the day part leave this function: never the
 * leave type, the reason, the status or a request id. A person shows on the work days of their range.
 */
export async function calendarMonth(
	db: Db,
	month: string
): Promise<{ weeks: (CalendarDay | null)[][]; truncated: boolean }> {
	const weeks = monthWeeks(month);
	const { first, last } = monthRange(month);
	const [{ days: workDays }, holidays, { results }] = await Promise.all([
		getWorkDays(db),
		listHolidays(db, first, last),
		db.$client
			.prepare(
				`SELECT r.start_on AS startOn, r.end_on AS endOn, r.half_day AS halfDay, e.full_name AS name
				 FROM leave_requests r JOIN employees e ON e.id = r.employee_id AND e.deleted_at IS NULL
				 WHERE r.status = 'approved' AND r.start_on <= ?2 AND r.end_on >= ?1
				 ORDER BY lower(e.full_name), r.start_on LIMIT ?3`
			)
			.bind(first, last, LEAVE_LIMITS.calendarRows + 1)
			.all<{ startOn: string; endOn: string; halfDay: HalfDayPart; name: string }>()
	]);
	const map = holidayMap(holidays);
	const names = new Map(holidays.map((h) => [h.onDate, h.name]));
	const rows = results.slice(0, LEAVE_LIMITS.calendarRows);
	const byDate = new Map<string, { name: string; part: HalfDayPart }[]>();
	for (const r of rows) {
		const from = Math.max(dayNumber(r.startOn), dayNumber(first));
		const to = Math.min(dayNumber(r.endOn), dayNumber(last));
		for (let d = from; d <= to; d += 1) {
			const date = dateOf(d);
			if (dayKind(date, workDays, map) !== 'work') continue;
			const list = byDate.get(date) ?? [];
			list.push({ name: r.name, part: r.startOn === r.endOn ? r.halfDay : 'none' });
			byDate.set(date, list);
		}
	}
	return {
		weeks: weeks.map((week) =>
			week.map((date) =>
				date ? { date, holiday: names.get(date) ?? null, out: byDate.get(date) ?? [] } : null
			)
		),
		truncated: results.length > LEAVE_LIMITS.calendarRows
	};
}
