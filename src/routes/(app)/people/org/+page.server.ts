import { requireUser } from '#lib/server/guards';
import { buildOrgTree } from '#lib/server/hr/org';
import { listActiveEmployees } from '#lib/server/hr/repo';
import { HR_LIMITS } from '#lib/server/hr/validation';
import type { PageServerLoad } from './$types';

/** The org chart of live, active employees (tier 0 only), from one query capped at HR_LIMITS.orgMax. */
export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const rows = await listActiveEmployees(event.locals.db, HR_LIMITS.orgMax + 1);
	const capped = rows.length > HR_LIMITS.orgMax;
	return {
		tree: buildOrgTree(capped ? rows.slice(0, HR_LIMITS.orgMax) : rows),
		count: Math.min(rows.length, HR_LIMITS.orgMax),
		capped
	};
};
