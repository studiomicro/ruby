import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { ViewKind } from '#lib/shared/enums';
import type { Db } from '../db';
import { savedViews } from '../db/schema';
import { projectActive } from '../tasks/repo';
import { isUniqueViolation, newId } from '../util';
import { holds, projectRefusal, type PmWrite } from './common';
import { PM_LIMITS, PM_MESSAGES } from './validation';

/**
 * Personal saved views (RB-08, owner decision 6): visible to their creator only. Every read and write names the
 * owner in its WHERE clause, so another user's view id is "not found". The unique partial indexes decide a duplicate
 * name; the 20-per-scope cap is a count inside the INSERT. `query` comes only from canonicalizeQuery.
 *
 * RB-12: one table and one code path for two scopes. `projectId` names a project (its `list` and `board` views), or
 * is null for the cross-project Issues views (`kind = 'issues'`, no project). Every statement filters by the scope,
 * so a project route never sees an Issues view and the Issues route never sees a project view.
 */

export interface SavedView {
	id: string;
	name: string;
	kind: ViewKind;
	query: string;
}

/** SQL: the row belongs to the scope (a project's views, or the Issues views when `projectId` is null). */
const inScope = (projectId: string | null) =>
	projectId === null
		? and(isNull(savedViews.projectId), eq(savedViews.kind, 'issues'))
		: eq(savedViews.projectId, projectId);
const scopeSql = (projectId: string | null) =>
	projectId === null ? sql`v.project_id is null` : sql`v.project_id = ${projectId}`;

const columns = {
	id: savedViews.id,
	name: savedViews.name,
	kind: savedViews.kind,
	query: savedViews.query
};

/** The user's live views of the scope by name. A batch item or awaited alone. */
export function listViewsQuery(db: Db, userId: string, projectId: string | null) {
	return db
		.select(columns)
		.from(savedViews)
		.where(and(eq(savedViews.userId, userId), inScope(projectId), isNull(savedViews.deletedAt)))
		.orderBy(asc(savedViews.name))
		.limit(PM_LIMITS.viewsPerUserProject * 2);
}

export async function listViews(
	db: Db,
	userId: string,
	projectId: string | null
): Promise<SavedView[]> {
	return listViewsQuery(db, userId, projectId);
}

/** The user's own live view of the project, or null (someone else's id looks missing). */
export async function getView(
	db: Db,
	userId: string,
	projectId: string | null,
	id: string
): Promise<SavedView | null> {
	const row = await db
		.select(columns)
		.from(savedViews)
		.where(
			and(
				eq(savedViews.id, id),
				eq(savedViews.userId, userId),
				inScope(projectId),
				isNull(savedViews.deletedAt)
			)
		)
		.get();
	return row ?? null;
}

export async function saveView(
	db: Db,
	userId: string,
	projectId: string | null,
	input: { name: string; kind: ViewKind; query: string },
	at: number
): Promise<PmWrite<{ id: string }>> {
	// The scope decides the kind: an Issues view is `issues`, a project view never is (the table CHECK agrees).
	if ((projectId === null) !== (input.kind === 'issues'))
		return { ok: false, reason: 'invalid', message: PM_MESSAGES.stale };
	const id = newId();
	try {
		const rows = await db
			.insert(savedViews)
			.select(
				db
					.select({
						id: sql`${id}`.as('id'),
						userId: sql`${userId}`.as('userId'),
						projectId: sql`${projectId}`.as('projectId'),
						name: sql`${input.name}`.as('name'),
						kind: sql`${input.kind}`.as('kind'),
						query: sql`${input.query}`.as('query'),
						createdAt: sql`${at}`.as('createdAt'),
						updatedAt: sql`${at}`.as('updatedAt'),
						deletedAt: sql`null`.as('deletedAt')
					})
					.from(sql`(select 1)`)
					.where(
						and(
							projectId === null ? undefined : projectActive(projectId),
							sql`(select count(*) from saved_views v where v.user_id = ${userId} and ${scopeSql(projectId)} and v.deleted_at is null) < ${PM_LIMITS.viewsPerUserProject}`
						)
					)
			)
			.returning({ id: savedViews.id });
		if (rows.length === 1) return { ok: true, id };
	} catch (e) {
		if (isUniqueViolation(e))
			return { ok: false, reason: 'duplicate', message: PM_MESSAGES.viewTaken };
		throw e;
	}
	if (projectId === null)
		return { ok: false, reason: 'limit', message: PM_MESSAGES.issueViewLimit };
	return (
		(await projectRefusal(db, projectId)) ?? {
			ok: false,
			reason: 'limit',
			message: PM_MESSAGES.viewLimit
		}
	);
}

/** Soft-deletes the user's own view; already deleted counts as done, someone else's is not found. */
export async function deleteView(
	db: Db,
	userId: string,
	projectId: string | null,
	id: string,
	at: number
): Promise<PmWrite> {
	const mine = and(eq(savedViews.id, id), eq(savedViews.userId, userId), inScope(projectId));
	const rows = await db
		.update(savedViews)
		.set({ deletedAt: at, updatedAt: at })
		.where(
			and(
				mine,
				isNull(savedViews.deletedAt),
				projectId === null ? undefined : projectActive(projectId)
			)
		)
		.returning({ id: savedViews.id });
	if (rows.length === 1) return { ok: true };
	const existed = await holds(
		db,
		sql`exists (select 1 from saved_views v where v.id = ${id} and v.user_id = ${userId} and ${scopeSql(projectId)})`
	);
	if (!existed) return { ok: false, reason: 'not_found' };
	return projectId === null
		? { ok: true }
		: ((await projectRefusal(db, projectId)) ?? { ok: true });
}
