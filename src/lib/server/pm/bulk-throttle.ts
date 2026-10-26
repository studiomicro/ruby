import { fail, type RequestEvent } from '@sveltejs/kit';
import { overUserAttemptLimit } from '../auth/throttle';
import type { SessionUser } from '../auth/session';
import type { PmAnswer } from './route';
import { PM_LIMITS, PM_MESSAGES } from './validation';

/**
 * RB-12 red team L3: one budget of bulk requests per user (`bulk-edit`, PM_LIMITS.bulkPerWindow per 10 minutes),
 * shared by the project list's and the Issues page's bulk bars, so a member cannot cycle reassignments (and their
 * notifications) across the workspace without limit. Counted before the form is read. Fails closed like every
 * throttle scope. Null when the request may go on, else the 429 answer.
 */
export async function bulkThrottled(
	event: Pick<RequestEvent, 'locals'>,
	user: Pick<SessionUser, 'id'>,
	at: number
) {
	if (
		!(await overUserAttemptLimit(
			event.locals.db,
			user.id,
			at,
			'bulk-edit',
			PM_LIMITS.bulkPerWindow
		))
	)
		return null;
	return fail(429, {
		pm: { section: 'bulk', ok: false, message: PM_MESSAGES.bulkThrottled } satisfies PmAnswer
	});
}
