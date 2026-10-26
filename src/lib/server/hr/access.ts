import { error, type RequestEvent } from '@sveltejs/kit';
import type { Db } from '../db';
import { requireUser } from '../guards';
import { getEnv } from '../env';
import { loadKey } from './crypto';
import type { Viewer } from './visibility';

/**
 * The HR view of the signed-in user, read from D1 on every request (never from the session cookie), so revoking
 * `is_hr` takes effect on the next request. Also finds the viewer's own live, active employee record (for "self" and
 * "direct manager").
 */
export async function loadViewer(db: Db, user: { id: string; role: string }): Promise<Viewer> {
	const row = await db.$client
		.prepare(
			`SELECT u.is_hr AS isHr,
				(SELECT e.id FROM employees e WHERE e.user_id = u.id AND e.deleted_at IS NULL AND e.status = 'active')
					AS ownEmployeeId
			 FROM users u WHERE u.id = ?1 AND u.status = 'active'`
		)
		.bind(user.id)
		.first<{ isHr: number; ownEmployeeId: string | null }>();
	return {
		userId: user.id,
		isHr: row?.isHr === 1,
		isAdmin: user.role === 'admin',
		ownEmployeeId: row?.ownEmployeeId ?? null
	};
}

/** `requireUser` plus the viewer's HR view. */
export async function requireViewer(event: Pick<RequestEvent, 'locals'>) {
	const user = requireUser(event);
	return { user, viewer: await loadViewer(event.locals.db, user) };
}

export const HR_ONLY = 'Only HR can do this.';

/** `requireUser`, then 403 unless the user holds the HR flag right now. */
export async function requireHr(event: Pick<RequestEvent, 'locals'>) {
	const found = await requireViewer(event);
	if (!found.viewer.isHr) error(403, HR_ONLY);
	return found;
}

export const KEY_NOT_CONFIGURED = 'Sensitive data storage is not configured.';

/** The HR field key, or null while HR_DATA_KEY is unset or malformed (sensitive data is then read-only). */
export const hrKey = () => loadKey(getEnv().HR_DATA_KEY);
