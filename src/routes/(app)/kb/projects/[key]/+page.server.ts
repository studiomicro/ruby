import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/guards';
import { loadScopeTree, noticeFor } from '#lib/server/kb/load';
import { getProjectByKey, listActiveProjects } from '#lib/server/kb/repo';
import { parseProjectKey } from '#lib/server/kb/validation';
import type { PageServerLoad } from './$types';

/** One project's pages. An unknown key or a deleted project is a 404; an archived one is shown, marked. */
export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const db = event.locals.db;
	const key = parseProjectKey(event.params.key);
	const project = key ? await getProjectByKey(db, key) : null;
	if (!project) error(404, 'Project not found.');
	const [tree, projects] = await Promise.all([
		loadScopeTree(db, project.id),
		listActiveProjects(db)
	]);
	return { project, tree, projects, notice: noticeFor(event.url) };
};
