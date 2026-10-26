import { requireAdmin } from '#lib/server/guards';
import type { PageServerLoad } from './$types';

/** `/admin`: the hub of the admin pages (users, team labels, attachment retention). */
export const load: PageServerLoad = (event) => {
	requireAdmin(event);
	return {};
};
