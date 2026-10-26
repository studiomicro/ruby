import { error, fail, type RequestEvent } from '@sveltejs/kit';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import { readFormBody, textField } from '#lib/server/forms';
import { requireViewer } from '#lib/server/hr/access';
import { STATUTORY_NOTE } from '#lib/server/timeoff/accrual';
import { yearOf } from '#lib/server/timeoff/calendar';
import { canCancel } from '#lib/server/timeoff/permissions';
import {
	balancesFor,
	countRange,
	listEmployeeRequests,
	listTypes,
	requestLeave,
	selfApprovalOpen
} from '#lib/server/timeoff/repo';
import { cancelRequest } from '#lib/server/timeoff/route';
import { LEAVE_LIMITS, LEAVE_MESSAGES, parseRequest } from '#lib/server/timeoff/validation';
import { teamToday } from '#lib/server/tasks/today';
import { now } from '#lib/server/util';
import { daysLabel, formatDays } from '#lib/shared/time-off';
import type { Actions, PageServerLoad } from './$types';

const NOT_LINKED = 'Your account is not linked to an employee record. Ask HR.';

/** My time off: balances of this year, my requests and the request form. Only the viewer's own employee. */
export const load: PageServerLoad = async (event) => {
	const { viewer } = await requireViewer(event);
	const today = teamToday();
	const db = event.locals.db;
	if (!viewer.ownEmployeeId) return { linked: false as const, today };
	const period = yearOf(today);
	// Read only: the balance includes the not-yet-written yearly grant; nothing is written on a page load.
	const [types, mine, requests, selfApproval] = await Promise.all([
		listTypes(db, true),
		balancesFor(db, [viewer.ownEmployeeId], period),
		listEmployeeRequests(db, viewer.ownEmployeeId),
		selfApprovalOpen(db, viewer)
	]);
	return {
		linked: true as const,
		today,
		period,
		note: STATUTORY_NOTE,
		selfApproval,
		types: types.map((t) => ({ id: t.id, name: t.name, requiresReason: t.requiresReason })),
		balances: mine.map((b) => ({
			typeId: b.typeId,
			typeName: b.typeName,
			entitled: b.entitled,
			used: b.used,
			pending: b.pending,
			available: b.available
		})),
		requests: requests.map((r) => ({
			id: r.id,
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
			cancelable: canCancel(viewer, r, today) !== null
		}))
	};
};

/** The viewer's own employee for a write, else the "not linked" refusal. */
async function own(event: RequestEvent) {
	const found = await requireViewer(event);
	if (!found.viewer.ownEmployeeId) error(403, NOT_LINKED);
	return { ...found, employeeId: found.viewer.ownEmployeeId };
}

async function parsed(event: RequestEvent) {
	const form = await readFormBody(event.request);
	const types = await listTypes(event.locals.db, true);
	return parseRequest(form, types, teamToday());
}

export const actions: Actions = {
	/** The day count of the form's range, with the stored holidays and work days; writes nothing. */
	preview: async (event) => {
		await own(event);
		const result = await parsed(event);
		if (!result.ok) return fail(400, { errors: result.errors, values: result.echo });
		const counted = await countRange(event.locals.db, result.value);
		const { weekends, holidays } = counted.skipped;
		const skipped = [
			holidays ? `${holidays} ${holidays === 1 ? 'holiday' : 'holidays'}` : null,
			weekends ? `${weekends} ${weekends === 1 ? 'weekend day' : 'weekend days'}` : null
		].filter(Boolean);
		return {
			values: { ...result.value, endOn: result.value.endOn },
			preview:
				counted.halfDays < 1
					? LEAVE_MESSAGES.noWorkDays
					: `This request uses ${daysLabel(counted.halfDays)}${skipped.length ? ` (${skipped.join(' and ')} skipped)` : ''}.`
		};
	},

	request: async (event) => {
		const { viewer, employeeId } = await own(event);
		const db = event.locals.db;
		const at = now();
		const result = await parsed(event);
		if (!result.ok) return fail(400, { errors: result.errors, values: result.echo });
		if (
			await overUserAttemptLimit(
				db,
				viewer.userId,
				at,
				'leave-request',
				LEAVE_LIMITS.requestsPerWindow
			)
		)
			return fail(429, { values: result.value, error: 'Too many requests. Wait a few minutes.' });
		const written = await requestLeave(db, { userId: viewer.userId, employeeId }, result.value, at);
		if (written.ok) return { requested: `Leave requested: ${daysLabel(written.halfDays)}.` };
		const values = result.value;
		switch (written.reason) {
			case 'no_work_days':
				return fail(400, { values, errors: { endOn: LEAVE_MESSAGES.noWorkDays } });
			case 'before_start':
				return fail(400, { values, errors: { startOn: LEAVE_MESSAGES.beforeStart } });
			case 'overlap':
				return fail(409, { values, error: LEAVE_MESSAGES.overlap });
			case 'pending_max':
				return fail(409, { values, error: LEAVE_MESSAGES.pendingMax });
			case 'balance':
				return fail(409, {
					values,
					error: `Not enough balance: ${formatDays(Math.max(0, written.available ?? 0))} days available, this request needs ${formatDays(written.halfDays ?? 0)}.`
				});
			default:
				return fail(400, { values, errors: { typeId: LEAVE_MESSAGES.type } });
		}
	},

	cancel: async (event) => {
		const { viewer } = await requireViewer(event);
		const form = await readFormBody(event.request);
		return cancelRequest(
			event.locals.db,
			viewer,
			textField(form, 'id'),
			textField(form, 'expected'),
			'own'
		);
	}
};
