import { HR_AUDIT_ACTIONS, type HrAuditAction } from '#lib/shared/enums';
import { cleanText } from '#lib/shared/text';
import type { Db } from '../db';
import { newId } from '../util';
import { PRIVATE_FIELDS, WORK_FIELD_COLUMNS } from './validation';

/**
 * The append-only HR audit log (`hr_audit_log`; migration 0002 aborts UPDATE and DELETE on it). A row names the
 * actor, the action, the employee or account it is about and the FIELD NAMES involved, never a value. Writes go in
 * the same D1 batch as the change they record, right after it, guarded by `changes() = 1`: the row exists exactly
 * when the change was written, and a failing audit insert rolls the change back.
 */

/** Every field name an audit row may carry. */
const AUDIT_FIELD_NAMES: ReadonlySet<string> = new Set([
	...Object.values(WORK_FIELD_COLUMNS),
	...PRIVATE_FIELDS,
	'status',
	'end_on',
	'user_id',
	'is_hr',
	'contact_name',
	'contact_phone',
	'relationship',
	'compensation_amount',
	'compensation_note',
	'effective_on',
	// RB-06 time off
	'half_days',
	'name',
	'kind',
	'annual_half_days',
	'requires_reason',
	'active',
	'on_date',
	'deducts_leave',
	'deleted_at',
	'work_days'
]);
const FIELDS_MAX = 20;
const DETAIL_MAX = 200;

export interface AuditEntry {
	actorId: string;
	action: HrAuditAction;
	employeeId?: string | null;
	/** The account the action is about (link, unlink, HR grant and revoke). */
	userId?: string | null;
	fields?: readonly string[];
	/** Short non-sensitive text, e.g. "42 rows". */
	detail?: string;
	at: number;
}

/** Refuses an unknown action or field name before anything is written (a programming error, not user input). */
function checked(entry: AuditEntry) {
	if (!(HR_AUDIT_ACTIONS as readonly string[]).includes(entry.action))
		throw new Error('unknown HR audit action');
	const fields = [...new Set(entry.fields ?? [])];
	if (fields.length > FIELDS_MAX || fields.some((f) => !AUDIT_FIELD_NAMES.has(f)))
		throw new Error('unknown HR audit field');
	return {
		id: newId(),
		fields: JSON.stringify(fields),
		detail: cleanText(entry.detail ?? '', DETAIL_MAX)
	};
}

/**
 * The audit INSERT as a batch item. `afterChange` (default): written only when the statement right before it in
 * the batch changed exactly one row. Otherwise unconditional (a reveal, an export, a listing).
 */
export function auditStatement(db: Db, entry: AuditEntry, afterChange = true): D1PreparedStatement {
	const { id, fields, detail } = checked(entry);
	return db.$client
		.prepare(
			`INSERT INTO hr_audit_log (id, at, actor_id, action, employee_id, user_id, fields, detail)
			 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE ${afterChange ? 'changes() = 1' : '1'}`
		)
		.bind(
			id,
			entry.at,
			entry.actorId,
			entry.action,
			entry.employeeId ?? null,
			entry.userId ?? null,
			fields,
			detail
		);
}

/** Writes one audit row on its own (reveal, export, listing); throws when D1 refuses it. */
export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
	await auditStatement(db, entry, false).run();
}

export interface AuditFilters {
	actorId: string | null;
	employeeId: string | null;
	action: HrAuditAction | null;
	/** UTC ms, inclusive. */
	fromAt: number | null;
	/** UTC ms, exclusive. */
	toAt: number | null;
	/** Cursor: rows strictly older than this (at, id). */
	before: { at: number; id: string } | null;
}

export interface AuditRow {
	id: string;
	at: number;
	action: string;
	actorName: string | null;
	employeeName: string | null;
	/** The row is about an employee whose name this viewer may not see (terminated or deleted, viewer not HR). */
	employeeHidden: boolean;
	userName: string | null;
	fields: string[];
	detail: string;
	/** The actor acted on their own record or account (RB-06: own leave balance or leave; an HR self-grant). */
	self: boolean;
}

/**
 * One page of the log, newest first, `limit` rows plus whether more exist (cursor `(at, id)`, no duplicates).
 * `allNames` false (a viewer who is not HR): employee names only for live, active employees; other rows keep their
 * action but say `employeeHidden` instead of a name (red team RB-05 L1).
 */
export async function listAudit(
	db: Db,
	filters: AuditFilters,
	limit: number,
	allNames = true
): Promise<{ rows: AuditRow[]; more: boolean }> {
	const where: string[] = [];
	const params: unknown[] = [];
	const add = (clause: string, ...values: unknown[]) => {
		where.push(clause);
		params.push(...values);
	};
	if (filters.actorId) add('l.actor_id = ?', filters.actorId);
	if (filters.employeeId) add('l.employee_id = ?', filters.employeeId);
	if (filters.action) add('l.action = ?', filters.action);
	if (filters.fromAt !== null) add('l.at >= ?', filters.fromAt);
	if (filters.toAt !== null) add('l.at < ?', filters.toAt);
	if (filters.before)
		add(
			'(l.at < ? OR (l.at = ? AND l.id < ?))',
			filters.before.at,
			filters.before.at,
			filters.before.id
		);
	const { results } = await db.$client
		.prepare(
			`SELECT l.id AS id, l.at AS at, l.action AS action, a.name AS actorName, ${allNames ? 'e.full_name' : "CASE WHEN e.deleted_at IS NULL AND e.status = 'active' THEN e.full_name END"}
					AS employeeName,
				(l.employee_id IS NOT NULL AND ${allNames ? '0' : "NOT (e.deleted_at IS NULL AND e.status = 'active')"})
					AS employeeHidden,
				u.name AS userName, l.fields AS fields, l.detail AS detail,
				(l.user_id IS NOT NULL AND l.user_id = l.actor_id) AS self
			 FROM hr_audit_log l
			 LEFT JOIN users a ON a.id = l.actor_id
			 LEFT JOIN employees e ON e.id = l.employee_id
			 LEFT JOIN users u ON u.id = l.user_id
			 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
			 ORDER BY l.at DESC, l.id DESC LIMIT ?`
		)
		.bind(...params, limit + 1)
		.all<
			Omit<AuditRow, 'fields' | 'employeeHidden' | 'self'> & {
				fields: string;
				employeeHidden: number;
				self: number;
			}
		>();
	const rows = results.slice(0, limit).map((r) => {
		let fields: string[] = [];
		try {
			const parsed: unknown = JSON.parse(r.fields);
			if (Array.isArray(parsed)) fields = parsed.filter((f): f is string => typeof f === 'string');
		} catch {
			fields = [];
		}
		return { ...r, employeeHidden: r.employeeHidden === 1, self: r.self === 1, fields };
	});
	return { rows, more: results.length > limit };
}

/** The UTC instant (ms) at which calendar date `date` (`YYYY-MM-DD`) begins in IANA zone `zone`. */
export function zoneDayStart(date: string, zone: string | undefined): number {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number];
	const guess = Date.UTC(y, m - 1, d);
	let offset: number;
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: zone || 'UTC',
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		}).formatToParts(guess);
		const p = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 0);
		offset =
			Date.UTC(p('year'), p('month') - 1, p('day'), p('hour'), p('minute'), p('second')) - guess;
	} catch {
		offset = 0;
	}
	return guess - offset;
}

/** `before` cursor text `<at>_<id>` of a row, and its parser (null for anything malformed). */
export const auditCursor = (row: { at: number; id: string }) => `${row.at}_${row.id}`;
export function parseAuditCursor(text: string | null): { at: number; id: string } | null {
	const m = /^(\d{1,16})_([0-9a-f-]{36})$/i.exec(text ?? '');
	if (!m) return null;
	const at = Number(m[1]);
	return Number.isSafeInteger(at) ? { at, id: m[2]!.toLowerCase() } : null;
}
