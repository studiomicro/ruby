import { error, fail, type RequestEvent } from '@sveltejs/kit';
import { readFormBody, textField } from '#lib/server/forms';
import { requireViewer } from '#lib/server/hr/access';
import { decide, hasReports, listApprovalQueue, selfApprovalOpen } from '#lib/server/timeoff/repo';
import { REQUEST_NOT_FOUND } from '#lib/server/timeoff/route';
import { LEAVE_MESSAGES, parseNote } from '#lib/server/timeoff/validation';
import { isUuid, parseExpected } from '#lib/server/tasks/validation';
import { now } from '#lib/server/util';
import { formatDays } from '#lib/shared/time-off';
import type { Actions, PageServerLoad } from './$types';

const NOT_FOUND = 'Page not found.';

/**
 * HR, managers, admins (the fallback approver) and a requester whose leave nobody else can approve (audited
 * self-approval); anyone else gets 404.
 */
async function approver(event: Pick<RequestEvent, 'locals'>) {
	const found = await requireViewer(event);
	const { viewer } = found;
	const db = event.locals.db;
	if (
		!viewer.isHr &&
		!viewer.isAdmin &&
		!(await hasReports(db, viewer)) &&
		!(await selfApprovalOpen(db, viewer))
	)
		error(404, NOT_FOUND);
	return found;
}

/** The queue of pending requests the viewer may decide (type and reason are visible to the approver). */
export const load: PageServerLoad = async (event) => {
	const { viewer } = await approver(event);
	const db = event.locals.db;
	const [queue, selfApproval] = await Promise.all([
		listApprovalQueue(db, viewer),
		selfApprovalOpen(db, viewer)
	]);
	return {
		selfApproval,
		queue: queue.map((r) => ({
			/** The viewer's own request (self-approval: logged). */
			own: r.createdBy === viewer.userId,
			id: r.id,
			employeeName: r.employeeName,
			typeName: r.typeName,
			startOn: r.startOn,
			endOn: r.endOn,
			halfDay: r.halfDay,
			halfDays: r.halfDays,
			reason: r.reason,
			remainingAfter: r.remainingAfter,
			overlaps: r.overlaps,
			updatedAt: r.updatedAt
		}))
	};
};

async function decideAction(event: RequestEvent, decision: 'approve' | 'reject') {
	const { viewer } = await approver(event);
	const form = await readFormBody(event.request);
	const id = textField(form, 'id').trim().toLowerCase();
	if (!isUuid(id)) error(404, REQUEST_NOT_FOUND);
	const note = parseNote(form);
	if (note === null) return fail(400, { id, error: LEAVE_MESSAGES.noteTooLong });
	const expected = parseExpected(textField(form, 'expected'));
	if (expected === null) return fail(409, { id, error: LEAVE_MESSAGES.changed });
	const result = await decide(event.locals.db, viewer, id, decision, note, expected, now());
	if (result.ok)
		return { decided: decision === 'approve' ? 'Request approved.' : 'Request rejected.' };
	switch (result.reason) {
		case 'not_found':
			error(404, REQUEST_NOT_FOUND);
			break;
		case 'decided':
			return fail(409, {
				id,
				error: result.decidedBy
					? `This request was already decided by ${result.decidedBy}.`
					: LEAVE_MESSAGES.decided
			});
		case 'balance':
			return fail(409, {
				id,
				error: `Not enough balance: ${formatDays(Math.max(0, result.available ?? 0))} days available, this request now needs ${formatDays(result.halfDays ?? 0)}.`
			});
		case 'no_work_days':
			return fail(409, {
				id,
				error:
					'With the current holidays and work days this range has no working days. Reject it instead.'
			});
		default:
			return fail(409, { id, error: LEAVE_MESSAGES.changed });
	}
}

export const actions: Actions = {
	approve: (event) => decideAction(event, 'approve'),
	reject: (event) => decideAction(event, 'reject')
};
