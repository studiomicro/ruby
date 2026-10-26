import { error, fail, redirect } from '@sveltejs/kit';
import { textField } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { PAGE_NOT_FOUND, readPageForm, requirePage } from '#lib/server/kb/load';
import { getBreadcrumbs, savePage } from '#lib/server/kb/repo';
import { KB_LIMITS, parseRevision } from '#lib/server/kb/validation';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/** The editor, filled with the current version; `expectedRevision` is the revision it was opened at. */
export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const db = event.locals.db;
	const page = await requirePage(db, event.params.id);
	return {
		page: {
			id: page.id,
			title: page.title,
			body: page.body,
			revision: page.revision,
			project: page.project
		},
		breadcrumbs: await getBreadcrumbs(db, page.id),
		limits: { title: KB_LIMITS.titleMax }
	};
};

type FieldErrors = Partial<Record<'form' | 'title' | 'body', string>>;

export const actions: Actions = {
	/**
	 * Saves against `expectedRevision`. A page changed meanwhile answers 409 with both versions (the conflict
	 * screen); "Save mine over theirs" resends with the newer revision. Nothing is merged automatically.
	 */
	save: async (event) => {
		const user = requireUser(event);
		const db = event.locals.db;
		const page = await requirePage(db, event.params.id);
		const { form, values, title, body } = await readPageForm(event.request);
		const expectedRaw = textField(form, 'expectedRevision');
		const expected = parseRevision(expectedRaw);
		const echo = { ...values, expectedRevision: expectedRaw };
		const errors: FieldErrors = {};
		if (title.error) errors.title = title.error;
		if (body.error) errors.body = body.error;
		if (expected === null) errors.form = 'This form is out of date. Reload the page and try again.';
		if (Object.keys(errors).length || expected === null) return fail(400, { values: echo, errors });
		const result = await savePage(
			db,
			user,
			page.id,
			{ title: title.value, body: body.value },
			expected,
			now()
		);
		if (result.kind === 'not-found') error(404, PAGE_NOT_FOUND);
		if (result.kind === 'conflict')
			return fail(409, { values: echo, errors: {} as FieldErrors, conflict: result.current });
		redirect(303, `/kb/${page.id}?notice=${result.kind === 'saved' ? 'saved' : 'unchanged'}`);
	},

	/** No-JS preview: echoes the input; the page renders the body through the Markdown component. */
	preview: async (event) => {
		requireUser(event);
		await requirePage(event.locals.db, event.params.id);
		const { form, values } = await readPageForm(event.request);
		return {
			values: { ...values, expectedRevision: textField(form, 'expectedRevision') },
			preview: values.body
		};
	}
};
