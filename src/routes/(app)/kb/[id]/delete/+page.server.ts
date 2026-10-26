import { error, fail, redirect } from '@sveltejs/kit';
import { readFormBody, textField } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { PAGE_NOT_FOUND, requirePage } from '#lib/server/kb/load';
import { DELETE_REFUSALS, deleteRefusal } from '#lib/server/kb/permissions';
import { deletePage, getBreadcrumbs, othersInSubtree, subtreeSize } from '#lib/server/kb/repo';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/** The confirmation: what goes (the page and how many subpages), and whether this user may delete it and why not. */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const db = event.locals.db;
	const page = await requirePage(db, event.params.id);
	const [size, breadcrumbs, others] = await Promise.all([
		subtreeSize(db, page.id),
		getBreadcrumbs(db, page.id),
		othersInSubtree(db, page.id, user.id)
	]);
	const refusal = deleteRefusal(user, page, others);
	return {
		page: { id: page.id, title: page.title, project: page.project },
		breadcrumbs,
		subpages: size.count - 1,
		canDelete: refusal === null,
		forbidden: refusal ? DELETE_REFUSALS[refusal] : null
	};
};

export const actions: Actions = {
	/**
	 * Soft-deletes the page and its subtree (an admin, or the creator of every page in it; `confirm=yes` required),
	 * then opens its space.
	 */
	delete: async (event) => {
		const user = requireUser(event);
		const db = event.locals.db;
		const page = await requirePage(db, event.params.id);
		const form = await readFormBody(event.request);
		if (textField(form, 'confirm') !== 'yes')
			return fail(400, { error: 'Confirm the deletion to continue.' });
		const result = await deletePage(db, user, page.id, now());
		if (result.kind === 'not-found') error(404, PAGE_NOT_FOUND);
		if (result.kind === 'forbidden') error(403, DELETE_REFUSALS[result.reason]);
		redirect(
			303,
			`${result.projectKey ? `/kb/projects/${result.projectKey}` : '/kb'}?notice=deleted`
		);
	}
};
