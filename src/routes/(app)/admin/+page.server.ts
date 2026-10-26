import { redirect } from '@sveltejs/kit';
import { requireAdmin } from '#lib/server/guards';
import type { PageServerLoad } from './$types';

/** `/admin` has one section for now: user management. */
export const load: PageServerLoad = (event) => {
	requireAdmin(event);
	redirect(303, '/admin/users');
};
