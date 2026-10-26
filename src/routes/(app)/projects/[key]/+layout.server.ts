import { error, redirect } from '@sveltejs/kit';
import { requireUser } from '#lib/server/guards';
import { canManageProject } from '#lib/server/projects/permissions';
import { PROJECT_NOT_FOUND, projectFromParams } from '#lib/server/projects/route';
import { normaliseKey } from '#lib/server/projects/validation';
import type { LayoutServerLoad } from './$types';

/**
 * Resolves the project for every page under /projects/[key]. A key typed in another case is sent (301) to the
 * upper-case URL; an unknown, malformed or deleted key is a 404 (one answer for all three).
 */
export const load: LayoutServerLoad = async (event) => {
	const user = requireUser(event);
	const raw = event.params.key;
	const key = normaliseKey(raw);
	if (key !== raw) {
		if (!key) error(404, PROJECT_NOT_FOUND);
		const rest = event.url.pathname.split('/').slice(3).join('/');
		redirect(301, `/projects/${key}${rest ? `/${rest}` : ''}${event.url.search}`);
	}
	const { project } = await projectFromParams(event);
	return {
		project: {
			id: project.id,
			key: project.key,
			name: project.name,
			description: project.description,
			status: project.status,
			leadId: project.leadId,
			leadName: project.leadName,
			createdBy: project.createdBy,
			updatedAt: project.updatedAt
		},
		canManage: canManageProject(user, project)
	};
};
