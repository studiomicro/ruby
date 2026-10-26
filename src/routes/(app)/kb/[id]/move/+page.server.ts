import { error, fail, redirect } from '@sveltejs/kit';
import { readFormBody, textField } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { PAGE_NOT_FOUND, requirePage } from '#lib/server/kb/load';
import {
	getBreadcrumbs,
	getProjectByKey,
	listActiveProjects,
	listScopePages,
	movePage,
	PROJECT_GONE,
	subtreeSize
} from '#lib/server/kb/repo';
import { buildTree, canMoveUnder, parentOptions, subtreeIds } from '#lib/server/kb/tree';
import { parseParentId, parsePlacement, parseProjectKey } from '#lib/server/kb/validation';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/**
 * The move form. `?scope=team|<KEY>` picks the target space (default: the page's own); the parent picker offers
 * that space's pages the page may go under (not itself or below itself, within the depth limit), and the placement
 * picker every page there to go after (the action checks it shares the chosen parent).
 */
export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const db = event.locals.db;
	const page = await requirePage(db, event.params.id);
	const projects = await listActiveProjects(db, { includeArchived: true });
	const scopeParam = event.url.searchParams.get('scope');
	const scopeKey = scopeParam === null ? (page.project?.key ?? null) : parseProjectKey(scopeParam);
	const target = scopeKey
		? (projects.find((p) => p.key.toUpperCase() === scopeKey.toUpperCase()) ?? null)
		: null;
	if (scopeParam !== null && scopeParam !== 'team' && !target) error(404, 'Project not found.');

	const [{ rows }, size, breadcrumbs] = await Promise.all([
		listScopePages(db, target?.id ?? null),
		subtreeSize(db, page.id),
		getBreadcrumbs(db, page.id)
	]);
	const nodes = buildTree(rows);
	const own = subtreeIds(rows, page.id);
	const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
	const sameScope = (target?.id ?? null) === page.projectId;

	return {
		page: { id: page.id, title: page.title, parentId: page.parentId, project: page.project },
		breadcrumbs,
		projects: projects.map((p) => ({
			key: p.key,
			name: p.name,
			archived: p.status === 'archived'
		})),
		scope: target ? target.key : 'team',
		scopeName: target ? target.name : 'Team',
		parents: parentOptions(nodes, (n) => canMoveUnder(rows, page.id, size.height, n.id)),
		siblings: parentOptions(nodes, (n) => !own.has(n.id)).map((o) => ({
			...o,
			parentId: parentOf.get(o.value) ?? ''
		})),
		currentParentId: sameScope ? (page.parentId ?? '') : '',
		subpages: size.count - 1
	};
};

export const actions: Actions = {
	/** Moves the page and its subpages; never creates a revision, so an open editor is not disturbed. */
	move: async (event) => {
		const user = requireUser(event);
		const db = event.locals.db;
		const page = await requirePage(db, event.params.id);
		const form = await readFormBody(event.request);
		const values = {
			scope: textField(form, 'scope'),
			parentId: textField(form, 'parentId'),
			placement: textField(form, 'placement')
		};
		let projectId: string | null = null;
		if (values.scope !== 'team' && values.scope !== '') {
			const key = parseProjectKey(values.scope);
			const project = key ? await getProjectByKey(db, key) : null;
			if (!project) return fail(400, { values, errors: { form: PROJECT_GONE } });
			projectId = project.id;
		}
		const parentId = parseParentId(values.parentId);
		const placement = parsePlacement(values.placement);
		if (parentId === undefined)
			return fail(400, { values, errors: { parent: 'Choose a parent from the list.' } });
		if (!placement)
			return fail(400, { values, errors: { placement: 'Choose a place from the list.' } });
		const result = await movePage(db, user, page.id, { parentId, projectId, placement }, now());
		if (result.kind === 'not-found') error(404, PAGE_NOT_FOUND);
		if (result.kind === 'invalid') {
			const key = result.field === 'project' ? 'form' : result.field;
			return fail(400, { values, errors: { [key]: result.error } });
		}
		redirect(303, `/kb/${page.id}?notice=moved`);
	}
};
