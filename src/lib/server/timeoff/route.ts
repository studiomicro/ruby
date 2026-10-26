import { error, fail } from '@sveltejs/kit';
import type { Db } from '../db';
import type { Viewer } from '../hr/visibility';
import { teamToday } from '../tasks/today';
import { isUuid, parseExpected } from '../tasks/validation';
import { now } from '../util';
import { canCancel } from './permissions';
import { cancel, getRequest } from './repo';
import { LEAVE_MESSAGES } from './validation';

export const REQUEST_NOT_FOUND = 'Request not found.';

/**
 * The cancel action of "My time off" (`own`: requests of the viewer's own employee record) and of the team page (`team`: HR only, an
 * audited override for someone else's request). A request outside the scope gets the same 404 as a missing id.
 */
export async function cancelRequest(
	db: Db,
	viewer: Viewer,
	rawId: string,
	rawExpected: string,
	scope: 'own' | 'team'
) {
	const id = rawId.trim().toLowerCase();
	if (!isUuid(id)) error(404, REQUEST_NOT_FOUND);
	const request = await getRequest(db, id);
	if (!request) error(404, REQUEST_NOT_FOUND);
	// The request belongs to the viewer when its employee is the viewer's employee now (red team L3).
	const own = viewer.ownEmployeeId !== null && request.employeeId === viewer.ownEmployeeId;
	if (scope === 'own' ? !own : !viewer.isHr) error(404, REQUEST_NOT_FOUND);
	const today = teamToday();
	if (request.status === 'canceled') return { canceled: 'Request canceled.' };
	const right = canCancel(viewer, request, today);
	if (!right)
		return fail(409, {
			error:
				request.status === 'approved'
					? 'This leave has started. Ask HR to cancel it.'
					: LEAVE_MESSAGES.decided
		});
	const expected = parseExpected(rawExpected);
	if (expected === null) return fail(409, { error: LEAVE_MESSAGES.changed });
	const result = await cancel(db, viewer, request, right === 'override', expected, today, now());
	if (result.ok) return { canceled: 'Request canceled.' };
	if (result.reason === 'not_found') error(404, REQUEST_NOT_FOUND);
	return fail(409, {
		error:
			result.reason === 'started'
				? 'This leave has started. Ask HR to cancel it.'
				: result.reason === 'decided'
					? LEAVE_MESSAGES.decided
					: LEAVE_MESSAGES.changed
	});
}
