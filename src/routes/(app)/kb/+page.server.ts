import { requireUser } from '#lib/server/guards';
import { loadScopeTree, noticeFor } from '#lib/server/kb/load';
import { listActiveProjects } from '#lib/server/kb/repo';
import type { PageServerLoad } from './$types';

/** The team-wide pages (`project_id IS NULL`) as an outline, and the spaces to switch to. */
export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const db = event.locals.db;
	const [tree, projects] = await Promise.all([loadScopeTree(db, null), listActiveProjects(db)]);
	return { tree, projects, notice: noticeFor(event.url) };
};
