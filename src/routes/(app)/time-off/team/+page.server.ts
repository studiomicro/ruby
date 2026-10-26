import { error } from '@sveltejs/kit';
import { LEAVE_STATUSES, type LeaveStatus } from '#lib/shared/enums';
import { readFormBody, textField } from '#lib/server/forms';
import { requireViewer } from '#lib/server/hr/access';
import { yearOf } from '#lib/server/timeoff/calendar';
import { canCancel } from '#lib/server/timeoff/permissions';
import { balancesFor, listTeamRequests, teamMembers } from '#lib/server/timeoff/repo';
import { cancelRequest } from '#lib/server/timeoff/route';
import { parseYear } from '#lib/server/timeoff/validation';
import { teamToday } from '#lib/server/tasks/today';
import type { Actions, PageServerLoad } from './$types';

/**
 * Requests and balances of the viewer's direct reports (HR: everyone). Anyone else, a skip-level manager
 * included, sees no one: with no reports and no HR flag the page is a 404. Filters: employee, status, year.
 */
export const load: PageServerLoad = async (event) => {
	const { viewer } = await requireViewer(event);
	const db = event.locals.db;
	const members = await teamMembers(db, viewer);
	if (!viewer.isHr && members.length === 0) error(404, 'Page not found.');
	const today = teamToday();
	const params = event.url.searchParams;
	const thisYear = yearOf(today);
	const year = parseYear(params.get('year')) ?? thisYear;
	const statusRaw = params.get('status') ?? '';
	const status = (LEAVE_STATUSES as readonly string[]).includes(statusRaw)
		? (statusRaw as LeaveStatus)
		: null;
	const employeeRaw = (params.get('employee') ?? '').toLowerCase();
	const selected = members.some((m) => m.id === employeeRaw) ? employeeRaw : '';
	const ids = selected ? [selected] : members.map((m) => m.id);
	// Read only: balances include the not-yet-written yearly grant (no ledger writes on a GET).
	const [balances, requests] = await Promise.all([
		balancesFor(db, ids, year),
		listTeamRequests(db, ids, { status, period: year })
	]);
	const names = new Map(members.map((m) => [m.id, m.fullName]));
	return {
		members,
		filters: { employee: selected, status: status ?? '', year: String(year) },
		year,
		years: [thisYear + 1, thisYear, thisYear - 1, thisYear - 2],
		isHr: viewer.isHr,
		balances: balances.map((b) => ({ ...b, employeeName: names.get(b.employeeId) ?? '' })),
		requests: requests.map((r) => ({
			id: r.id,
			employeeName: r.employeeName,
			typeName: r.typeName,
			startOn: r.startOn,
			endOn: r.endOn,
			halfDay: r.halfDay,
			halfDays: r.halfDays,
			reason: r.reason,
			status: r.status,
			decidedByName: r.decidedByName,
			decisionNote: r.decisionNote,
			selfApproved: r.selfApproved === 1,
			updatedAt: r.updatedAt,
			cancelable: viewer.isHr && canCancel(viewer, r, today) !== null
		}))
	};
};

export const actions: Actions = {
	/** HR cancels any pending or approved request (an audited override unless it is their own). */
	cancel: async (event) => {
		const { viewer } = await requireViewer(event);
		const form = await readFormBody(event.request);
		return cancelRequest(
			event.locals.db,
			viewer,
			textField(form, 'id'),
			textField(form, 'expected'),
			'team'
		);
	}
};
