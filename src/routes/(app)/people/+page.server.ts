import { error } from '@sveltejs/kit';
import { requireViewer } from '#lib/server/hr/access';
import { writeAudit } from '#lib/server/hr/audit';
import { distinctDepartments, listEmployees } from '#lib/server/hr/repo';
import { HR_LIMITS, parseDirectoryQuery } from '#lib/server/hr/validation';
import { errorLabel, now } from '#lib/server/util';
import type { PageServerLoad } from './$types';

/**
 * The employee directory: tier 0 columns of live, active employees for every signed-in user. HR also filters by
 * status (terminated, all, deleted); opening such a listing writes a `list_terminated` audit row first and is
 * refused if that row cannot be written.
 */
export const load: PageServerLoad = async (event) => {
	const { viewer } = await requireViewer(event);
	const query = parseDirectoryQuery(event.url.searchParams, viewer.isHr);
	if (!query) error(400, `Search for at most ${HR_LIMITS.q} characters.`);
	const db = event.locals.db;
	if (viewer.isHr && query.status !== 'active') {
		try {
			await writeAudit(db, {
				actorId: viewer.userId,
				action: 'list_terminated',
				detail: query.status,
				at: now()
			});
		} catch (e) {
			console.error('people: audit insert failed', errorLabel(e));
			error(503, 'This listing is unavailable right now. Try again.');
		}
	}
	const [{ rows, total }, departments] = await Promise.all([
		listEmployees(db, query),
		distinctDepartments(db, viewer.isHr)
	]);
	return {
		rows: rows.map((r) => ({
			...r,
			// Status and deletion are HR information; others only ever see active, live employees.
			status: viewer.isHr ? r.status : 'active',
			deletedAt: viewer.isHr ? r.deletedAt : null
		})),
		total,
		departments,
		query,
		pageSize: HR_LIMITS.pageSize,
		isHr: viewer.isHr,
		canAudit: viewer.isHr || viewer.isAdmin
	};
};
