import {
	LAST4_FIELDS,
	SENSITIVE_FIELDS,
	type EmployeeStatus,
	type EmploymentType,
	type SensitiveField
} from '#lib/shared/enums';
import type { Db } from '../db';
import { isUniqueViolation, newId } from '../util';
import { auditStatement, type AuditEntry } from './audit';
import { encryptField, KEY_VERSION } from './crypto';
import { cancelPendingRequests } from '../timeoff/hooks';
import {
	HR_LIMITS,
	HR_MESSAGES,
	last4,
	WORK_FIELD_COLUMNS,
	WORK_FIELDS,
	type CompensationInput,
	type ContactInput,
	type DirectoryQuery,
	type Errors,
	type PrivateChanges,
	type PrivateField,
	type WorkFields
} from './validation';

/**
 * RB-05 data access over raw, parameterised D1 statements (the guarded SQL of the PRD reads best as SQL). Every
 * write is one `db.batch`: the guarded change, then its audit row (`changes() = 1`). Plaintext of tier 2 and tier 3
 * values exists only between the form parser and `encryptField`; nothing here returns a ciphertext to a caller
 * except `secretOf`, which the reveal flow alone uses.
 */

export interface EmployeeRow {
	id: string;
	userId: string | null;
	employeeNo: string | null;
	fullName: string;
	preferredName: string | null;
	jobTitle: string | null;
	department: string | null;
	location: string | null;
	workEmail: string | null;
	workPhone: string | null;
	managerId: string | null;
	/** The manager's name while the manager is a live, active employee. */
	managerName: string | null;
	employmentType: EmploymentType;
	status: EmployeeStatus;
	startOn: string | null;
	probationEndsOn: string | null;
	endOn: string | null;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
	linkedUserName: string | null;
	linkedUserStatus: 'active' | 'disabled' | null;
}

const EMPLOYEE_SELECT = `SELECT e.id AS id, e.user_id AS userId, e.employee_no AS employeeNo, e.full_name AS fullName,
	e.preferred_name AS preferredName, e.job_title AS jobTitle, e.department AS department, e.location AS location,
	e.work_email AS workEmail, e.work_phone AS workPhone, e.manager_id AS managerId,
	CASE WHEN m.deleted_at IS NULL AND m.status = 'active' THEN m.full_name END AS managerName,
	e.employment_type AS employmentType, e.status AS status, e.start_on AS startOn,
	e.probation_ends_on AS probationEndsOn, e.end_on AS endOn, e.created_at AS createdAt, e.updated_at AS updatedAt,
	e.deleted_at AS deletedAt, u.name AS linkedUserName, u.status AS linkedUserStatus
	FROM employees e
	LEFT JOIN employees m ON m.id = e.manager_id
	LEFT JOIN users u ON u.id = e.user_id`;

/** One employee in any state (live, terminated or deleted), or null. Callers apply the visibility rule. */
export async function getEmployee(db: Db, id: string): Promise<EmployeeRow | null> {
	return db.$client.prepare(`${EMPLOYEE_SELECT} WHERE e.id = ?1`).bind(id).first<EmployeeRow>();
}

// ── Directory ──────────────────────────────────────────────────────────────────────────────────────────────

export type DirectoryRow = Pick<
	EmployeeRow,
	| 'id'
	| 'fullName'
	| 'preferredName'
	| 'jobTitle'
	| 'department'
	| 'location'
	| 'workEmail'
	| 'workPhone'
	| 'managerId'
	| 'managerName'
	| 'status'
	| 'deletedAt'
>;

const SEARCH_COLUMNS = [
	'e.full_name',
	'e.preferred_name',
	'e.job_title',
	'e.department',
	'e.location',
	'e.work_email'
];

function directoryWhere(query: Pick<DirectoryQuery, 'q' | 'department' | 'status'>) {
	const where: string[] = [];
	const params: unknown[] = [];
	if (query.status === 'deleted') where.push('e.deleted_at IS NOT NULL');
	else where.push('e.deleted_at IS NULL');
	if (query.status === 'active' || query.status === 'terminated') {
		where.push('e.status = ?');
		params.push(query.status);
	}
	if (query.department) {
		where.push('e.department = ?');
		params.push(query.department);
	}
	if (query.q) {
		// instr, not LIKE: D1 refuses LIKE patterns over 50 bytes, and %, _ and \ then match literally.
		where.push(
			`(${SEARCH_COLUMNS.map((c) => `instr(lower(coalesce(${c}, '')), ?) > 0`).join(' OR ')})`
		);
		for (let i = 0; i < SEARCH_COLUMNS.length; i++) params.push(query.q.toLowerCase());
	}
	return { sql: where.join(' AND '), params };
}

/** One directory page (tier 0 columns only, plus status for HR's filter) and the total. */
export async function listEmployees(
	db: Db,
	query: DirectoryQuery
): Promise<{ rows: DirectoryRow[]; total: number }> {
	const { sql, params } = directoryWhere(query);
	const order =
		query.sort === 'department'
			? 'e.department IS NULL, lower(e.department), lower(e.full_name), e.id'
			: 'lower(e.full_name), e.id';
	const [page, count] = await db.$client.batch<DirectoryRow | { n: number }>([
		db.$client
			.prepare(
				`SELECT e.id AS id, e.full_name AS fullName, e.preferred_name AS preferredName, e.job_title AS jobTitle,
					e.department AS department, e.location AS location, e.work_email AS workEmail,
					e.work_phone AS workPhone, e.manager_id AS managerId,
					CASE WHEN m.deleted_at IS NULL AND m.status = 'active' THEN m.full_name END AS managerName,
					e.status AS status, e.deleted_at AS deletedAt
				 FROM employees e LEFT JOIN employees m ON m.id = e.manager_id
				 WHERE ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`
			)
			.bind(...params, HR_LIMITS.pageSize, (query.page - 1) * HR_LIMITS.pageSize),
		db.$client.prepare(`SELECT count(*) AS n FROM employees e WHERE ${sql}`).bind(...params)
	]);
	return {
		rows: (page?.results ?? []) as DirectoryRow[],
		total: Number((count?.results[0] as { n: number } | undefined)?.n ?? 0)
	};
}

/** Distinct departments for the filter (live employees; active ones only unless `all`). */
export async function distinctDepartments(db: Db, all: boolean): Promise<string[]> {
	const { results } = await db.$client
		.prepare(
			`SELECT DISTINCT department AS d FROM employees
			 WHERE deleted_at IS NULL AND department IS NOT NULL ${all ? '' : "AND status = 'active'"}
			 ORDER BY lower(department) LIMIT 200`
		)
		.all<{ d: string }>();
	return results.map((r) => r.d);
}

/** Live, active employees for the manager picker and the org chart (id, name, title, manager), capped. */
export async function listActiveEmployees(db: Db, limit: number = HR_LIMITS.orgMax) {
	const { results } = await db.$client
		.prepare(
			`SELECT id, full_name AS fullName, preferred_name AS preferredName, job_title AS jobTitle,
				manager_id AS managerId
			 FROM employees WHERE deleted_at IS NULL AND status = 'active'
			 ORDER BY lower(full_name), id LIMIT ?1`
		)
		.bind(limit)
		.all<{
			id: string;
			fullName: string;
			preferredName: string | null;
			jobTitle: string | null;
			managerId: string | null;
		}>();
	return results;
}

/** Live employees for HR's CSV export (tier 0 and tier 1 columns only), capped at HR_LIMITS.orgMax. */
export async function listForExport(db: Db): Promise<EmployeeRow[]> {
	const { results } = await db.$client
		.prepare(
			`${EMPLOYEE_SELECT} WHERE e.deleted_at IS NULL ORDER BY lower(e.full_name), e.id LIMIT ?1`
		)
		.bind(HR_LIMITS.orgMax)
		.all<EmployeeRow>();
	return results;
}

/** Employees for the audit-log filter, capped: every state for HR (`all`), live and active ones otherwise. */
export async function listEmployeeNames(db: Db, all = true) {
	// Without `all` (a viewer who is not HR) only live, active employees: status and deletion are HR facts.
	const { results } = await db.$client
		.prepare(
			`SELECT id, full_name AS fullName FROM employees
			 ${all ? '' : "WHERE deleted_at IS NULL AND status = 'active'"}
			 ORDER BY lower(full_name), id LIMIT ?1`
		)
		.bind(HR_LIMITS.orgMax)
		.all<{ id: string; fullName: string }>();
	return results;
}

/** Active accounts not linked to a live employee (HR's link picker). */
export async function listLinkableUsers(db: Db) {
	const { results } = await db.$client
		.prepare(
			`SELECT u.id AS id, u.name AS name FROM users u
			 WHERE u.status = 'active'
				AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id AND e.deleted_at IS NULL)
			 ORDER BY lower(u.name), u.id LIMIT 500`
		)
		.all<{ id: string; name: string }>();
	return results;
}

// ── Writes on `employees` ──────────────────────────────────────────────────────────────────────────────────

export type HrWrite =
	| { ok: true; id?: string }
	| { ok: false; reason: 'not_found' }
	| { ok: false; reason: 'conflict'; current: EmployeeRow }
	| { ok: false; reason: 'invalid'; errors: Errors };

const LIVE_ACTIVE_MANAGER = `EXISTS (SELECT 1 FROM employees m WHERE m.id = ? AND m.deleted_at IS NULL
	AND m.status = 'active')`;
/**
 * True when `?2` is `?1` or one of its descendants (the manager-cycle guard). The walk includes soft-deleted rows:
 * they keep `manager_id`, and a later restore would otherwise close a loop through them (red team RB-05 L3).
 */
const IS_DESCENDANT = `EXISTS (WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT c.id FROM employees c
	JOIN sub ON c.manager_id = sub.id) SELECT 1 FROM sub WHERE sub.id = ?)`;
/** For the restore UPDATE: the row's own stored manager (`employees.manager_id`) is not one of its descendants. */
const RESTORE_KEEPS_TREE = `(manager_id IS NULL OR NOT EXISTS (WITH RECURSIVE sub(id) AS (SELECT ? UNION
	SELECT c.id FROM employees c JOIN sub ON c.manager_id = sub.id) SELECT 1 FROM sub
	WHERE sub.id = employees.manager_id))`;
export const RESTORE_CYCLE =
	'Its manager now reports to this employee. Give that manager another manager first, then restore.';

const uniqueErrors = (e: unknown): Errors | null => {
	if (!isUniqueViolation(e)) return null;
	const msg = String((e as Error)?.message) + String((e as { cause?: Error })?.cause?.message);
	if (msg.includes('employees.user_id')) return { userId: 'That account is already linked.' };
	return { employeeNo: 'That employee number is already used.' };
};

/** Whether `managerId` can be the manager of `employeeId` (null id: a new employee). */
async function managerError(
	db: Db,
	employeeId: string | null,
	managerId: string
): Promise<string | null> {
	const row = await db.$client
		.prepare(`SELECT ${LIVE_ACTIVE_MANAGER} AS live, ${employeeId ? IS_DESCENDANT : '0'} AS below`)
		.bind(managerId, ...(employeeId ? [employeeId, managerId] : []))
		.first<{ live: number; below: number }>();
	if (!row?.live) return HR_MESSAGES.manager;
	if (row.below) return 'Choose someone who does not report to this employee.';
	return null;
}

export async function createEmployee(
	db: Db,
	actorId: string,
	fields: WorkFields,
	now: number
): Promise<HrWrite> {
	const id = newId();
	const insert = db.$client
		.prepare(
			`INSERT INTO employees (id, user_id, employee_no, full_name, preferred_name, job_title, department, location,
				work_email, work_phone, manager_id, employment_type, status, start_on, probation_ends_on, end_on,
				created_by, created_at, updated_at, deleted_at)
			 SELECT ?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active', ?12, ?13, NULL, ?14, ?15, ?15, NULL
			 WHERE ?10 IS NULL OR EXISTS (SELECT 1 FROM employees m WHERE m.id = ?10 AND m.deleted_at IS NULL
				AND m.status = 'active')`
		)
		.bind(
			id,
			fields.employeeNo,
			fields.fullName,
			fields.preferredName,
			fields.jobTitle,
			fields.department,
			fields.location,
			fields.workEmail,
			fields.workPhone,
			fields.managerId,
			fields.employmentType,
			fields.startOn,
			fields.probationEndsOn,
			actorId,
			now
		);
	const audit = auditStatement(db, {
		actorId,
		action: 'employee_create',
		employeeId: id,
		fields: WORK_FIELDS.filter((f) => fields[f] !== null).map((f) => WORK_FIELD_COLUMNS[f]),
		at: now
	});
	try {
		const [written] = await db.$client.batch([insert, audit]);
		if (written?.meta.changes === 1) return { ok: true, id };
	} catch (e) {
		const errors = uniqueErrors(e);
		if (errors) return { ok: false, reason: 'invalid', errors };
		throw e;
	}
	return { ok: false, reason: 'invalid', errors: { managerId: HR_MESSAGES.manager } };
}

/**
 * The one guarded UPDATE of an employee plus its audit row: written only while the row is at `expected`, `where`
 * holds and (unless `deleted`) the row is live. Null when nothing was written.
 */
async function writeEmployee(
	db: Db,
	o: {
		id: string;
		expected: number;
		now: number;
		set: string;
		params: unknown[];
		where?: string;
		whereParams?: unknown[];
		deleted?: boolean;
		audit: Omit<AuditEntry, 'at' | 'employeeId'>;
		/** Batch items after the audit row, given the `updated_at` the UPDATE writes (RB-06 leave hook). */
		after?: (updatedAt: number) => D1PreparedStatement[];
	}
): Promise<boolean> {
	const updatedAt = Math.max(o.now, o.expected + 1);
	const update = db.$client
		.prepare(
			`UPDATE employees SET ${o.set}, updated_at = ? WHERE id = ? AND updated_at = ?
			 AND deleted_at IS ${o.deleted ? 'NOT NULL' : 'NULL'} ${o.where ? `AND ${o.where}` : ''}`
		)
		.bind(...o.params, updatedAt, o.id, o.expected, ...(o.whereParams ?? []));
	const audit = auditStatement(db, { ...o.audit, employeeId: o.id, at: o.now });
	const [written] = await db.$client.batch([update, audit, ...(o.after?.(updatedAt) ?? [])]);
	return written?.meta.changes === 1;
}

/** Why a guarded write wrote nothing: gone (or in the wrong deleted state), changed meanwhile, or null (invalid). */
async function refusal(
	db: Db,
	id: string,
	expected: number,
	deleted = false
): Promise<Exclude<HrWrite, { ok: true }> | null> {
	const current = await getEmployee(db, id);
	if (!current || (current.deletedAt !== null) !== deleted)
		return { ok: false, reason: 'not_found' };
	if (current.updatedAt !== expected) return { ok: false, reason: 'conflict', current };
	return null;
}

/** The work fields that differ between the stored row and `fields`. */
export function changedWorkFields(current: EmployeeRow, fields: Partial<WorkFields>) {
	return (Object.keys(fields) as (keyof WorkFields)[]).filter(
		(f) => (current[f] ?? null) !== (fields[f] ?? null)
	);
}

/**
 * HR's edit of work and employment fields, or an employee's own preferred name and work phone (`fields` holds only
 * what the form may change). A new manager must be live and active and must not be the employee or report to them
 * (checked inside the UPDATE, so two edits that would together form a cycle cannot both pass).
 */
export async function updateWork(
	db: Db,
	actorId: string,
	current: EmployeeRow,
	fields: Partial<WorkFields>,
	expected: number,
	now: number
): Promise<HrWrite> {
	const changed = changedWorkFields(current, fields);
	if (changed.length === 0) {
		if (current.updatedAt !== expected) return { ok: false, reason: 'conflict', current };
		return { ok: true };
	}
	const managerChange = changed.includes('managerId') && fields.managerId ? fields.managerId : null;
	try {
		const written = await writeEmployee(db, {
			id: current.id,
			expected,
			now,
			set: changed.map((f) => `${WORK_FIELD_COLUMNS[f]} = ?`).join(', '),
			params: changed.map((f) => fields[f] ?? null),
			where: managerChange ? `${LIVE_ACTIVE_MANAGER} AND NOT ${IS_DESCENDANT}` : undefined,
			whereParams: managerChange ? [managerChange, current.id, managerChange] : [],
			audit: {
				actorId,
				action: 'employee_update',
				fields: changed.map((f) => WORK_FIELD_COLUMNS[f])
			}
		});
		if (written) return { ok: true };
	} catch (e) {
		const errors = uniqueErrors(e);
		if (errors) return { ok: false, reason: 'invalid', errors };
		throw e;
	}
	const refused = await refusal(db, current.id, expected);
	if (refused) return refused;
	const managerProblem = managerChange ? await managerError(db, current.id, managerChange) : null;
	if (managerProblem)
		return { ok: false, reason: 'invalid', errors: { managerId: managerProblem } };
	return { ok: false, reason: 'conflict', current: (await getEmployee(db, current.id)) ?? current };
}

/** Terminates an active employee (`end_on` set); repeating it on a terminated employee is a no-op success. */
export async function terminate(
	db: Db,
	actorId: string,
	current: EmployeeRow,
	endOn: string,
	expected: number,
	now: number
): Promise<HrWrite> {
	if (current.status === 'terminated') return { ok: true };
	const written = await writeEmployee(db, {
		id: current.id,
		expected,
		now,
		set: "status = 'terminated', end_on = ?",
		params: [endOn],
		where: "status = 'active' AND (start_on IS NULL OR start_on <= ?)",
		whereParams: [endOn],
		audit: { actorId, action: 'employee_terminate', fields: ['status', 'end_on'] },
		// RB-06: the employee's pending leave requests are canceled in the same batch.
		after: (updatedAt) => [
			cancelPendingRequests(db, actorId, current.id, updatedAt, now, 'terminated')
		]
	});
	if (written) return { ok: true };
	const refused = await refusal(db, current.id, expected);
	if (refused) return refused;
	const now2 = await getEmployee(db, current.id);
	if (now2?.status === 'terminated') return { ok: true };
	return { ok: false, reason: 'invalid', errors: { endOn: HR_MESSAGES.beforeStart } };
}

/** Makes a terminated employee active again and clears `end_on`; a no-op success when already active. */
export async function reinstate(
	db: Db,
	actorId: string,
	current: EmployeeRow,
	expected: number,
	now: number
): Promise<HrWrite> {
	if (current.status === 'active') return { ok: true };
	const written = await writeEmployee(db, {
		id: current.id,
		expected,
		now,
		set: "status = 'active', end_on = NULL",
		params: [],
		where: "status = 'terminated'",
		audit: { actorId, action: 'employee_reinstate', fields: ['status', 'end_on'] }
	});
	if (written) return { ok: true };
	return (await refusal(db, current.id, expected)) ?? { ok: true };
}

/** Soft delete; frees the employee number and the account link for reuse (partial unique indexes). */
export async function softDelete(
	db: Db,
	actorId: string,
	id: string,
	expected: number,
	now: number
): Promise<HrWrite> {
	const written = await writeEmployee(db, {
		id,
		expected,
		now,
		set: 'deleted_at = ?',
		params: [now],
		audit: { actorId, action: 'employee_delete' },
		// RB-06: the employee's pending leave requests are canceled in the same batch.
		after: (updatedAt) => [cancelPendingRequests(db, actorId, id, updatedAt, now, 'deleted')]
	});
	if (written) return { ok: true };
	return (await refusal(db, id, expected)) ?? { ok: false, reason: 'not_found' };
}

/**
 * Restores a soft-deleted employee. Refused with a form error when its number or account was taken meanwhile, or
 * when its stored manager now reports to it (restoring would close a manager cycle; checked inside the UPDATE).
 */
export async function restore(
	db: Db,
	actorId: string,
	id: string,
	expected: number,
	now: number
): Promise<HrWrite> {
	try {
		const written = await writeEmployee(db, {
			id,
			expected,
			now,
			set: 'deleted_at = NULL',
			params: [],
			deleted: true,
			where: RESTORE_KEEPS_TREE,
			whereParams: [id],
			audit: { actorId, action: 'employee_restore' }
		});
		if (written) return { ok: true };
	} catch (e) {
		if (isUniqueViolation(e))
			return {
				ok: false,
				reason: 'invalid',
				errors: { form: 'Its employee number or linked account is now used by someone else.' }
			};
		throw e;
	}
	return (
		(await refusal(db, id, expected, true)) ?? {
			ok: false,
			reason: 'invalid',
			errors: { form: RESTORE_CYCLE }
		}
	);
}

/** Links an active account to the employee (one live employee per account; set by HR, never by e-mail match). */
export async function linkUser(
	db: Db,
	actorId: string,
	id: string,
	userId: string,
	expected: number,
	now: number
): Promise<HrWrite> {
	try {
		const written = await writeEmployee(db, {
			id,
			expected,
			now,
			set: 'user_id = ?',
			params: [userId],
			where: "EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.status = 'active')",
			whereParams: [userId],
			audit: { actorId, action: 'user_link', userId, fields: ['user_id'] }
		});
		if (written) return { ok: true };
	} catch (e) {
		const errors = uniqueErrors(e);
		if (errors) return { ok: false, reason: 'invalid', errors };
		throw e;
	}
	return (
		(await refusal(db, id, expected)) ?? {
			ok: false,
			reason: 'invalid',
			errors: { userId: 'Choose an active account.' }
		}
	);
}

export async function unlinkUser(
	db: Db,
	actorId: string,
	current: EmployeeRow,
	expected: number,
	now: number
): Promise<HrWrite> {
	if (!current.userId) return { ok: true };
	const written = await writeEmployee(db, {
		id: current.id,
		expected,
		now,
		set: 'user_id = NULL',
		params: [],
		audit: { actorId, action: 'user_unlink', userId: current.userId, fields: ['user_id'] }
	});
	if (written) return { ok: true };
	return (await refusal(db, current.id, expected)) ?? { ok: true };
}

// ── Tier 2: `employee_private` ─────────────────────────────────────────────────────────────────────────────

export interface PrivateSummary {
	/** `updated_at` of the row, 0 while it does not exist (the first write's `expected`). */
	updatedAt: number;
	/** Which encrypted fields hold a value; never the value. */
	set: Record<SensitiveField, boolean>;
	/** The last four digits of the identifiers that have them. */
	last4: Partial<Record<(typeof LAST4_FIELDS)[number], string>>;
	bankName: string | null;
}

/** What the masked view needs. The ciphertexts are read only to tell set from empty and are not returned. */
export async function privateSummary(db: Db, employeeId: string): Promise<PrivateSummary> {
	const row = await db.$client
		.prepare(
			`SELECT ${SENSITIVE_FIELDS.map((f) => `${f}_enc IS NOT NULL AS ${f}`).join(', ')},
				${LAST4_FIELDS.map((f) => `${f}_last4 AS ${f}_last4`).join(', ')},
				bank_name AS bankName, updated_at AS updatedAt
			 FROM employee_private WHERE employee_id = ?1`
		)
		.bind(employeeId)
		.first<Record<string, unknown>>();
	const set = Object.fromEntries(SENSITIVE_FIELDS.map((f) => [f, row?.[f] === 1])) as Record<
		SensitiveField,
		boolean
	>;
	const l4: PrivateSummary['last4'] = {};
	for (const f of LAST4_FIELDS) {
		const v = row?.[`${f}_last4`];
		if (typeof v === 'string') l4[f] = v;
	}
	return {
		updatedAt: Number(row?.updatedAt ?? 0),
		set,
		last4: l4,
		bankName: (row?.bankName as string | null | undefined) ?? null
	};
}

export type PrivateWrite =
	{ ok: true } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'conflict' };

/**
 * Writes tier 2 changes (`null` clears a field), each value encrypted with `<employee id>|<field>`. The row is
 * created empty first (`updated_at` 0) and then updated against `expected`, with the `sensitive_update` audit row
 * (field names only) in the same batch.
 */
export async function updatePrivate(
	db: Db,
	key: CryptoKey,
	actorId: string,
	employeeId: string,
	changes: PrivateChanges,
	expected: number,
	now: number
): Promise<PrivateWrite> {
	const fields = Object.keys(changes) as PrivateField[];
	if (fields.length === 0) return { ok: true };
	const set: string[] = [];
	const params: unknown[] = [];
	for (const field of fields) {
		const value = changes[field] ?? null;
		if (field === 'bank_name') {
			set.push('bank_name = ?');
			params.push(value);
			continue;
		}
		set.push(`${field}_enc = ?`);
		params.push(value === null ? null : await encryptField(key, employeeId, field, value));
		if ((LAST4_FIELDS as readonly string[]).includes(field)) {
			set.push(`${field}_last4 = ?`);
			params.push(value === null ? null : last4(value));
		}
	}
	const updatedAt = Math.max(now, expected + 1);
	const live = 'EXISTS (SELECT 1 FROM employees e WHERE e.id = ? AND e.deleted_at IS NULL)';
	const [, written] = await db.$client.batch([
		db.$client
			.prepare(
				`INSERT INTO employee_private (employee_id, key_version, updated_by, updated_at)
				 SELECT ?1, ?2, ?3, 0 WHERE ${live.replace('?', '?1')} ON CONFLICT(employee_id) DO NOTHING`
			)
			.bind(employeeId, KEY_VERSION, actorId),
		db.$client
			.prepare(
				`UPDATE employee_private SET ${set.join(', ')}, key_version = ?, updated_by = ?, updated_at = ?
				 WHERE employee_id = ? AND updated_at = ? AND ${live}`
			)
			.bind(...params, KEY_VERSION, actorId, updatedAt, employeeId, expected, employeeId),
		auditStatement(db, { actorId, action: 'sensitive_update', employeeId, fields, at: now })
	]);
	if (written?.meta.changes === 1) return { ok: true };
	const employee = await getEmployee(db, employeeId);
	return employee && employee.deletedAt === null
		? { ok: false, reason: 'conflict' }
		: { ok: false, reason: 'not_found' };
}

// ── Tier 2: emergency contacts ─────────────────────────────────────────────────────────────────────────────

export async function listContacts(db: Db, employeeId: string) {
	const { results } = await db.$client
		.prepare(
			`SELECT id, relationship FROM employee_emergency_contacts
			 WHERE employee_id = ?1 AND deleted_at IS NULL ORDER BY position, id LIMIT ?2`
		)
		.bind(employeeId, HR_LIMITS.contactsMax)
		.all<{ id: string; relationship: string }>();
	return results;
}

export type ContactWrite = { ok: true } | { ok: false; reason: 'not_found' | 'full' };

/** Adds a contact unless the employee already has HR_LIMITS.contactsMax live ones (checked inside the INSERT). */
export async function addContact(
	db: Db,
	key: CryptoKey,
	actorId: string,
	employeeId: string,
	input: ContactInput,
	now: number
): Promise<ContactWrite> {
	const id = newId();
	const [nameEnc, phoneEnc] = await Promise.all([
		encryptField(key, id, 'contact_name', input.name),
		encryptField(key, id, 'contact_phone', input.phone)
	]);
	const [written] = await db.$client.batch([
		db.$client
			.prepare(
				`INSERT INTO employee_emergency_contacts (id, employee_id, name_enc, relationship, phone_enc, key_version,
					position, created_at, updated_at, deleted_at)
				 SELECT ?1, ?2, ?3, ?4, ?5, ?6,
					(SELECT coalesce(max(position), 0) + 1 FROM employee_emergency_contacts WHERE employee_id = ?2),
					?7, ?7, NULL
				 WHERE EXISTS (SELECT 1 FROM employees e WHERE e.id = ?2 AND e.deleted_at IS NULL)
					AND (SELECT count(*) FROM employee_emergency_contacts
						WHERE employee_id = ?2 AND deleted_at IS NULL) < ?8`
			)
			.bind(
				id,
				employeeId,
				nameEnc,
				input.relationship,
				phoneEnc,
				KEY_VERSION,
				now,
				HR_LIMITS.contactsMax
			),
		auditStatement(db, {
			actorId,
			action: 'emergency_update',
			employeeId,
			fields: ['contact_name', 'relationship', 'contact_phone'],
			detail: 'added',
			at: now
		})
	]);
	if (written?.meta.changes === 1) return { ok: true };
	const employee = await getEmployee(db, employeeId);
	return employee && employee.deletedAt === null
		? { ok: false, reason: 'full' }
		: { ok: false, reason: 'not_found' };
}

export async function removeContact(
	db: Db,
	actorId: string,
	employeeId: string,
	contactId: string,
	now: number
): Promise<ContactWrite> {
	const [written] = await db.$client.batch([
		db.$client
			.prepare(
				`UPDATE employee_emergency_contacts SET deleted_at = ?1, updated_at = ?1
				 WHERE id = ?2 AND employee_id = ?3 AND deleted_at IS NULL`
			)
			.bind(now, contactId, employeeId),
		auditStatement(db, {
			actorId,
			action: 'emergency_update',
			employeeId,
			fields: ['contact_name', 'relationship', 'contact_phone'],
			detail: 'removed',
			at: now
		})
	]);
	return written?.meta.changes === 1 ? { ok: true } : { ok: false, reason: 'not_found' };
}

// ── Tier 3: salary records ─────────────────────────────────────────────────────────────────────────────────

export async function listCompensation(db: Db, employeeId: string) {
	const { results } = await db.$client
		.prepare(
			`SELECT c.id AS id, c.effective_on AS effectiveOn, c.currency AS currency,
				c.note_enc IS NOT NULL AS hasNote, c.created_at AS createdAt, u.name AS createdByName
			 FROM employee_compensation c LEFT JOIN users u ON u.id = c.created_by
			 WHERE c.employee_id = ?1 ORDER BY c.effective_on DESC, c.created_at DESC LIMIT 100`
		)
		.bind(employeeId)
		.all<{
			id: string;
			effectiveOn: string;
			currency: string;
			hasNote: number;
			createdAt: number;
			createdByName: string | null;
		}>();
	return results.map((r) => ({ ...r, hasNote: r.hasNote === 1 }));
}

/** Appends a salary record (amount and note encrypted with `<record id>|<field>`) and its audit row. */
export async function addCompensation(
	db: Db,
	key: CryptoKey,
	actorId: string,
	employeeId: string,
	input: CompensationInput,
	now: number
): Promise<{ ok: boolean }> {
	const id = newId();
	const amountEnc = await encryptField(key, id, 'compensation_amount', String(input.amountMinor));
	const noteEnc = input.note ? await encryptField(key, id, 'compensation_note', input.note) : null;
	const [written] = await db.$client.batch([
		db.$client
			.prepare(
				`INSERT INTO employee_compensation (id, employee_id, effective_on, amount_enc, currency, note_enc,
					key_version, created_by, created_at)
				 SELECT ?1, ?2, ?3, ?4, 'IDR', ?5, ?6, ?7, ?8
				 WHERE EXISTS (SELECT 1 FROM employees e WHERE e.id = ?2 AND e.deleted_at IS NULL)`
			)
			.bind(id, employeeId, input.effectiveOn, amountEnc, noteEnc, KEY_VERSION, actorId, now),
		auditStatement(db, {
			actorId,
			action: 'compensation_add',
			employeeId,
			fields: ['effective_on', 'compensation_amount', ...(noteEnc ? ['compensation_note'] : [])],
			at: now
		})
	]);
	return { ok: written?.meta.changes === 1 };
}

// ── Reveal source ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The ciphertext a reveal asks for and the row id it is bound to, or null when there is none. `ref` names the
 * contact or salary record; it must belong to `employeeId` (an id from a form never widens the scope).
 */
export async function secretOf(
	db: Db,
	employeeId: string,
	field: string,
	ref: string | null
): Promise<{ rowId: string; token: string; keyVersion: number } | null> {
	if ((SENSITIVE_FIELDS as readonly string[]).includes(field)) {
		const row = await db.$client
			.prepare(
				`SELECT ${field}_enc AS token, key_version AS keyVersion FROM employee_private WHERE employee_id = ?1`
			)
			.bind(employeeId)
			.first<{ token: string | null; keyVersion: number }>();
		return row?.token ? { rowId: employeeId, token: row.token, keyVersion: row.keyVersion } : null;
	}
	if (!ref) return null;
	const source =
		field === 'contact_name' || field === 'contact_phone'
			? `SELECT ${field === 'contact_name' ? 'name_enc' : 'phone_enc'} AS token, key_version AS keyVersion
				FROM employee_emergency_contacts
				WHERE id = ?1 AND employee_id = ?2 AND deleted_at IS NULL`
			: field === 'compensation_amount' || field === 'compensation_note'
				? `SELECT ${field === 'compensation_amount' ? 'amount_enc' : 'note_enc'} AS token, key_version AS keyVersion
					FROM employee_compensation WHERE id = ?1 AND employee_id = ?2`
				: null;
	if (!source) return null;
	const row = await db.$client
		.prepare(source)
		.bind(ref, employeeId)
		.first<{ token: string | null; keyVersion: number }>();
	return row?.token ? { rowId: ref, token: row.token, keyVersion: row.keyVersion } : null;
}
