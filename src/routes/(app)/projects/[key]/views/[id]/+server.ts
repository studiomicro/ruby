import { error, redirect } from '@sveltejs/kit';
import { isUuid } from '#lib/server/tasks/validation';
import { getView } from '#lib/server/pm/views';
import { projectFromParams } from '#lib/server/projects/route';
import type { RequestHandler } from './$types';

/**
 * Opens a saved view (RB-08): the owner is sent to the project's list or board with the stored filters. Another
 * user's view, a deleted one and an unknown id all get the same 404.
 */
export const GET: RequestHandler = async (event) => {
	const { user, project } = await projectFromParams(event);
	const id = event.params.id;
	const view = isUuid(id)
		? await getView(event.locals.db, user.id, project.id, id.toLowerCase())
		: null;
	if (!view) error(404, 'View not found.');
	redirect(303, `/projects/${project.key}${view.query ? `?${view.query}` : ''}`);
};
