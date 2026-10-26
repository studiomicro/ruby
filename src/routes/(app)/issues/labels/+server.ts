import { json } from '@sveltejs/kit';
import { requireUser } from '#lib/server/guards';
import { projectLabelsByKeyQuery } from '#lib/server/issues/repo';
import { normaliseKey } from '#lib/server/projects/validation';
import type { RequestHandler } from './$types';

/**
 * The Report form's project-label group (RB-12): the live labels of the active project `?project=KEY`, at most 30.
 * An unknown, archived, deleted or malformed key answers an empty list (one answer for all). Never cached.
 */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	const key = normaliseKey(event.url.searchParams.get('project') ?? '');
	const labels = key ? await projectLabelsByKeyQuery(event.locals.db, key) : [];
	return json({ labels }, { headers: { 'cache-control': 'private, no-store' } });
};
