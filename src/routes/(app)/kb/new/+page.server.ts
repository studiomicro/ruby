import { error, fail, redirect } from '@sveltejs/kit';
import type { Db } from '#lib/server/db';
import { textField } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { loadScopeTree, readPageForm } from '#lib/server/kb/load';
import { createPage, getPage, getProjectByKey, type ProjectRef } from '#lib/server/kb/repo';
import { parentOptions } from '#lib/server/kb/tree';
import { isUuid, KB_LIMITS, parseParentId, parseProjectKey } from '#lib/server/kb/validation';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/**
 * The scope a new page goes into: `project` (a key; empty for team-wide). An unknown or deleted project is a 404,
 * like its space page.
 */
async function scopeFor(db: Db, rawKey: string): Promise<ProjectRef | null> {
	if (rawKey === '') return null;
	const key = parseProjectKey(rawKey);
	const project = key ? await getProjectByKey(db, key) : null;
	if (!project) error(404, 'Project not found.');
	return project;
}

/**
 * The create form. `?project=<KEY>` picks the space and `?parent=<page id>` the parent; a parent decides the space
 * (a child always lives in its parent's space). The parent picker lists the space's pages that still have room for
 * a child (depth limit).
 */
export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const db = event.locals.db;
	const parentParam = event.url.searchParams.get('parent')?.toLowerCase() ?? '';
	const parent = isUuid(parentParam) ? await getPage(db, parentParam) : null;
	const project = parent
		? parent.project
		: await scopeFor(db, event.url.searchParams.get('project') ?? '');
	const tree = await loadScopeTree(db, project?.id ?? null);
	return {
		project,
		parentId: parent?.id ?? '',
		parents: parentOptions(tree.nodes, (node) => node.depth < KB_LIMITS.maxDepth),
		limits: { title: KB_LIMITS.titleMax }
	};
};

export const actions: Actions = {
	/** Creates the page (and its revision 1) and opens it. */
	create: async (event) => {
		const user = requireUser(event);
		const db = event.locals.db;
		const { form, values, title, body } = await readPageForm(event.request);
		const parentRaw = textField(form, 'parentId');
		const parentId = parseParentId(parentRaw);
		const project = await scopeFor(db, textField(form, 'project'));
		const errors: Partial<Record<'form' | 'title' | 'body' | 'parent', string>> = {};
		if (title.error) errors.title = title.error;
		if (body.error) errors.body = body.error;
		if (parentId === undefined) errors.parent = 'Choose a parent page from the list.';
		if (Object.keys(errors).length)
			return fail(400, { values: { ...values, parentId: parentRaw }, errors });
		const result = await createPage(
			db,
			user,
			{
				title: title.value,
				body: body.value,
				projectId: project?.id ?? null,
				parentId: parentId ?? null
			},
			now()
		);
		if (!result.ok)
			return fail(400, {
				values: { ...values, parentId: parentRaw },
				errors: result.field === 'parent' ? { parent: result.error } : { form: result.error }
			});
		redirect(303, `/kb/${result.id}?notice=created`);
	},

	/** No-JS preview: echoes the input; the page renders the body through the Markdown component. */
	preview: async (event) => {
		requireUser(event);
		const { form, values } = await readPageForm(event.request);
		return { values: { ...values, parentId: textField(form, 'parentId') }, preview: values.body };
	}
};
