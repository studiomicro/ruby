import { listProjects, projectOpenCounts } from '#lib/server/projects/repo';
import { requireUser } from '#lib/server/guards';
import type { PageServerLoad } from './$types';

/** Active projects, or archived ones with `?archived=1`, each with its open-task count. */
export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const archived = event.url.searchParams.get('archived') === '1';
	const projects = await listProjects(event.locals.db, { archived });
	const open = await projectOpenCounts(
		event.locals.db,
		projects.map((p) => p.id)
	);
	return {
		archived,
		projects: projects.map((p) => ({
			id: p.id,
			key: p.key,
			name: p.name,
			leadId: p.leadId,
			leadName: p.leadName,
			updatedAt: p.updatedAt,
			open: open.get(p.id) ?? 0
		}))
	};
};
