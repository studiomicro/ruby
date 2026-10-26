import { requireUser } from '#lib/server/guards';
import { unreadCount } from '#lib/server/notifications/repo';
import { decidableCount } from '#lib/server/timeoff/repo';
import { errorLabel } from '#lib/server/util';
import type { LayoutServerLoad } from './$types';

/**
 * The shell's data: who is signed in (id, name, e-mail, role: display only, every page still checks access itself)
 * and the unread-notification count for the badge (plus RB-06's count of leave requests to decide), bounded by UNREAD_COUNT_CAP. A failed count shows no badge
 * rather than failing every page. Reading the path makes this load run again on every navigation, so the badge is
 * fresh on each page (RB-03: no real-time updates; one indexed count per navigation).
 */
export const load: LayoutServerLoad = async (event) => {
	const user = requireUser(event);
	void event.url.pathname;
	let unread = 0;
	let pendingApprovals = 0;
	const [unreadResult, pendingResult] = await Promise.allSettled([
		unreadCount(event.locals.db, user.id),
		// RB-06: leave requests this user may decide (HR, the employee's manager, the fallback admin).
		decidableCount(event.locals.db, user.id)
	]);
	if (unreadResult.status === 'fulfilled') unread = unreadResult.value;
	else console.error('app layout: unread count failed', errorLabel(unreadResult.reason));
	if (pendingResult.status === 'fulfilled') pendingApprovals = pendingResult.value;
	else console.error('app layout: leave approval count failed', errorLabel(pendingResult.reason));
	return {
		user: { id: user.id, name: user.name, email: user.email, role: user.role },
		unread,
		pendingApprovals
	};
};
