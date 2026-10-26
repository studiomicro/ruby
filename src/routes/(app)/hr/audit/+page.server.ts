import { error } from '@sveltejs/kit';
import { HR_AUDIT_ACTIONS, type HrAuditAction } from '#lib/shared/enums';
import { getEnv } from '#lib/server/env';
import { requireViewer } from '#lib/server/hr/access';
import {
	auditCursor,
	listAudit,
	parseAuditCursor,
	zoneDayStart,
	type AuditFilters
} from '#lib/server/hr/audit';
import { listEmployeeNames } from '#lib/server/hr/repo';
import { DATE_MAX, DATE_MIN, HR_LIMITS, isUuid } from '#lib/server/hr/validation';
import { isCalendarDate } from '#lib/server/tasks/dates';
import type { PageServerLoad } from './$types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The HR audit log, read-only, for HR and admins (roadmap decision 14). Newest first, cursor-paginated. An admin who
 * is not HR sees names of live, active employees only (terminated and deleted are HR facts).
 */
export const load: PageServerLoad = async (event) => {
	const { viewer } = await requireViewer(event);
	if (!viewer.isHr && !viewer.isAdmin) error(403, 'Only HR and admins can read the HR audit log.');
	const p = event.url.searchParams;
	const zone = getEnv().TEAM_TIME_ZONE;
	const id = (name: string) => {
		const v = (p.get(name) ?? '').toLowerCase();
		return isUuid(v) ? v : null;
	};
	const date = (name: string) => {
		const v = p.get(name) ?? '';
		return isCalendarDate(v, DATE_MIN, DATE_MAX) ? v : null;
	};
	const actionRaw = p.get('action') ?? '';
	const from = date('from');
	const to = date('to');
	const filters: AuditFilters = {
		actorId: id('actor'),
		employeeId: id('employee'),
		action: (HR_AUDIT_ACTIONS as readonly string[]).includes(actionRaw)
			? (actionRaw as HrAuditAction)
			: null,
		fromAt: from ? zoneDayStart(from, zone) : null,
		toAt: to ? zoneDayStart(to, zone) + DAY_MS : null,
		before: parseAuditCursor(p.get('before'))
	};
	const db = event.locals.db;
	const [{ rows, more }, employees, actors] = await Promise.all([
		listAudit(db, filters, HR_LIMITS.auditPageSize, viewer.isHr),
		listEmployeeNames(db, viewer.isHr),
		db.$client
			.prepare('SELECT id, name FROM users ORDER BY lower(name), id LIMIT 500')
			.all<{ id: string; name: string }>()
	]);
	const last = rows.at(-1);
	return {
		rows,
		next: more && last ? auditCursor(last) : null,
		paged: filters.before !== null,
		filters: {
			actor: filters.actorId ?? '',
			employee: filters.employeeId ?? '',
			action: filters.action ?? '',
			from: from ?? '',
			to: to ?? ''
		},
		employees,
		actors: actors.results
	};
};
