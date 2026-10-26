import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/guards';
import { PAGE_NOT_FOUND, requirePage, restoreAction } from '#lib/server/kb/load';
import { getBreadcrumbs, getRevision } from '#lib/server/kb/repo';
import { parseRevision } from '#lib/server/kb/validation';
import type { Actions, PageServerLoad } from './$types';

/** One revision, read-only (rendered through the Markdown component). `0`, `abc` or another page's number: 404. */
export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const db = event.locals.db;
	const page = await requirePage(db, event.params.id);
	const number = parseRevision(event.params.revision);
	const revision = number === null ? null : await getRevision(db, page.id, number);
	if (!revision) error(404, PAGE_NOT_FOUND);
	return {
		page: { id: page.id, title: page.title, revision: page.revision, project: page.project },
		breadcrumbs: await getBreadcrumbs(db, page.id),
		revision
	};
};

export const actions: Actions = { restore: restoreAction };
