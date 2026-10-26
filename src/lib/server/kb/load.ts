import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import type { Db } from '../db';
import { readFormBody, textField } from '../forms';
import { requireUser } from '../guards';
import { now } from '../util';
import { getPage, listScopePages, restoreRevision, type PageDetail } from './repo';
import { ancestorIds, buildTree, type TreeNode } from './tree';
import { checkBody, checkTitle, isUuid, KB_LIMITS, parseRevision } from './validation';

/** The one answer for a malformed, missing or deleted page id (no existence oracle). */
export const PAGE_NOT_FOUND = 'Page not found.';

/** The live page `idParam` names, or a 404 — the same 404 for a malformed, missing or deleted id. */
export async function requirePage(db: Db, idParam: string | undefined): Promise<PageDetail> {
	const id = idParam?.toLowerCase() ?? '';
	const page = isUuid(id) ? await getPage(db, id) : null;
	if (!page) error(404, PAGE_NOT_FOUND);
	return page;
}

export interface ScopeTree {
	nodes: TreeNode[];
	/** Branches shown open: the ancestors of the current page, or the top level when there is none. */
	openIds: string[];
	truncated: boolean;
	count: number;
}

/** One scope's outline, opened down to `currentId` (or one level when there is no current page). */
export async function loadScopeTree(
	db: Db,
	projectId: string | null,
	currentId: string | null = null
): Promise<ScopeTree> {
	const { rows, truncated } = await listScopePages(db, projectId);
	const nodes = buildTree(rows);
	return {
		nodes,
		openIds: currentId ? [...ancestorIds(rows, currentId), currentId] : nodes.map((n) => n.id),
		truncated,
		count: rows.length
	};
}

/** Success notices a redirect after a confirmed write carries (`?notice=`); unknown values show nothing. */
const NOTICES = {
	created: 'Page created.',
	saved: 'Page saved.',
	unchanged: 'No changes to save.',
	moved: 'Page moved.',
	deleted: 'Page deleted.'
} as const;

/**
 * The banner text for `url`'s notice. `restored` reads `from` and `to` (revision numbers, digits only) and says
 * "Restored revision N as M"; nothing from the URL is shown except those numbers.
 */
export function noticeFor(url: URL): string | null {
	const notice = url.searchParams.get('notice');
	if (notice === 'restored') {
		const from = url.searchParams.get('from') ?? '';
		const to = url.searchParams.get('to') ?? '';
		return /^[1-9][0-9]{0,8}$/.test(from) && /^[1-9][0-9]{0,8}$/.test(to)
			? `Restored revision ${from} as revision ${to}.`
			: 'Revision restored.';
	}
	return notice && Object.hasOwn(NOTICES, notice) ? NOTICES[notice as keyof typeof NOTICES] : null;
}

/** The editor's fields as sent, and each one checked (validation.ts). The raw values are echoed on a refusal. */
export async function readPageForm(request: Request) {
	const form = await readFormBody(request, KB_LIMITS.formMaxBytes);
	const values = { title: textField(form, 'title'), body: textField(form, 'body') };
	return { form, values, title: checkTitle(values.title), body: checkBody(values.body) };
}

export const RESTORE_CONFLICT = 'Page changed meanwhile, review and retry.';

/**
 * The `restore` action of the history pages: restores the form's `revision` as a new revision against the form's
 * `expectedRevision` (the page's revision when the list was rendered). A page changed since answers 409; a
 * revision of another page, or none, is the page 404.
 */
export async function restoreAction(event: RequestEvent) {
	const user = requireUser(event);
	const db = event.locals.db;
	const page = await requirePage(db, event.params.id);
	const form = await readFormBody(event.request);
	const revision = parseRevision(textField(form, 'revision'));
	const expected = parseRevision(textField(form, 'expectedRevision'));
	if (revision === null) error(404, PAGE_NOT_FOUND);
	if (expected === null) return fail(400, { restoreError: RESTORE_CONFLICT });
	const result = await restoreRevision(db, user, page.id, revision, expected, now());
	if (result.kind === 'not-found') error(404, PAGE_NOT_FOUND);
	if (result.kind === 'conflict') return fail(409, { restoreError: RESTORE_CONFLICT });
	if (result.kind === 'unchanged') redirect(303, `/kb/${page.id}?notice=unchanged`);
	redirect(303, `/kb/${page.id}?notice=restored&from=${revision}&to=${result.revision}`);
}
