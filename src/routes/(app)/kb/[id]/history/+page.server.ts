import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/guards';
import { requirePage, restoreAction } from '#lib/server/kb/load';
import { getBreadcrumbs, listRevisions } from '#lib/server/kb/repo';
import { KB_LIMITS, parseRevision } from '#lib/server/kb/validation';
import type { Actions, PageServerLoad } from './$types';

/** The page's revisions, newest first, KB_LIMITS.historyPageSize per page (`?page=`). Revisions run 1..N. */
export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const db = event.locals.db;
	const page = await requirePage(db, event.params.id);
	const pageParam = event.url.searchParams.get('page');
	const pageNo = pageParam === null ? 1 : parseRevision(pageParam);
	const pages = Math.max(1, Math.ceil(page.revision / KB_LIMITS.historyPageSize));
	if (pageNo === null || pageNo > pages) error(404, 'Page not found.');
	const [revisions, breadcrumbs] = await Promise.all([
		listRevisions(db, page.id, pageNo),
		getBreadcrumbs(db, page.id)
	]);
	return {
		page: { id: page.id, title: page.title, revision: page.revision, project: page.project },
		breadcrumbs,
		revisions,
		pageNo,
		pages
	};
};

export const actions: Actions = { restore: restoreAction };
