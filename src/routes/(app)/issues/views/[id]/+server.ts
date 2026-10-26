import { error, redirect } from '@sveltejs/kit';
import { requireUser } from '#lib/server/guards';
import { getView } from '#lib/server/pm/views';
import { isUuid } from '#lib/server/tasks/validation';
import type { RequestHandler } from './$types';

/**
 * Opens a saved Issues view (RB-12): the owner is sent to /issues with the stored filters. Another user's view, a
 * deleted one, a project view and an unknown id all get the same 404.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = event.params.id;
	const view = isUuid(id) ? await getView(event.locals.db, user.id, null, id.toLowerCase()) : null;
	if (!view) error(404, 'View not found.');
	redirect(303, `/issues${view.query ? `?${view.query}` : ''}`);
};
