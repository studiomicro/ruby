import { commentActions } from '#lib/server/comments/actions';
import { loadThread } from '#lib/server/comments/service';
import { attachmentPanel } from '#lib/server/attachments/panel';
import { requireUser } from '#lib/server/guards';
import { loadScopeTree, noticeFor, requirePage } from '#lib/server/kb/load';
import { deleteRefusal } from '#lib/server/kb/permissions';
import { getBreadcrumbs, getChildren, othersInSubtree } from '#lib/server/kb/repo';
import type { Actions, PageServerLoad } from './$types';

/** A page: breadcrumbs, rendered body (in the template, through the Markdown component), children and its space's outline. */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const db = event.locals.db;
	const page = await requirePage(db, event.params.id);
	const [breadcrumbs, children, tree, others, comments, attachments] = await Promise.all([
		getBreadcrumbs(db, page.id),
		getChildren(db, page.id),
		loadScopeTree(db, page.projectId, page.id),
		user.role === 'admin' || page.createdBy !== user.id ? 0 : othersInSubtree(db, page.id, user.id),
		loadThread(db, user, { kind: 'page', id: page.id }, event.url),
		// RB-04: the page's files.
		attachmentPanel(db, user, 'page', page.id, event.url)
	]);
	return {
		attachments,
		page,
		breadcrumbs,
		children,
		tree,
		// Display only: the delete action and its UPDATE decide.
		canDelete: deleteRefusal(user, page, others) === null,
		notice: noticeFor(event.url),
		/** RB-03: the comment thread (CommentThread). */
		comments
	};
};

export const actions: Actions = {
	/** RB-03: `commentCreate`, `commentEdit`, `commentDelete` on this page. */
	...commentActions(async (event) => {
		requireUser(event);
		const page = await requirePage(event.locals.db, event.params.id);
		return { kind: 'page', id: page.id, href: `/kb/${page.id}` };
	})
};
