import { eq, sql } from 'drizzle-orm';
import type { SessionUser } from '../auth/session';
import type { Db } from '../db';
import { projects } from '../db/schema';

/**
 * What every RB-08 write answers. A refusal names why nothing was written; routes map it to 404 (not_found, one
 * answer for hidden and missing), 403 (forbidden), 409 (archived, conflict) or 400 (the rest, with a message).
 */
export type PmReason =
	'not_found' | 'forbidden' | 'archived' | 'conflict' | 'limit' | 'duplicate' | 'invalid';
export type PmRefusal = {
	ok: false;
	reason: PmReason;
	message?: string;
	/** Field errors (an `invalid` form), by field name. */
	errors?: Record<string, string>;
};
export type PmWrite<T = object> = ({ ok: true } & T) | PmRefusal;

/** Why a guarded project-scoped write wrote nothing: the project is gone or archived, or null (neither). */
export async function projectRefusal(db: Db, projectId: string): Promise<PmRefusal | null> {
	const row = await db
		.select({ status: projects.status, deletedAt: projects.deletedAt })
		.from(projects)
		.where(eq(projects.id, projectId))
		.get();
	if (!row || row.deletedAt !== null) return { ok: false, reason: 'not_found' };
	if (row.status !== 'active') return { ok: false, reason: 'archived' };
	return null;
}

/** Who a manager-only write is checked against: the RB-01 rule needs the id and the role. */
export type Manager = Pick<SessionUser, 'id' | 'role'>;

/**
 * SQL: `actor` may manage the project when the statement runs: an admin, or the project's lead or creator (the
 * RB-01 rule, `mayManage` in projects/repo.ts). Part of every manager-only RB-08 write, so a lead replaced between
 * the route's check and the write writes nothing.
 */
export const mayManageProject = (projectId: string, actor: Manager) =>
	actor.role === 'admin'
		? sql`1 = 1`
		: sql`exists (select 1 from projects p where p.id = ${projectId} and (p.lead_id = ${actor.id} or p.created_by = ${actor.id}))`;

/** A manager-only write found nothing: forbidden when the rule fails now, else null (look further). */
export async function managerRefusal(
	db: Db,
	projectId: string,
	actor: Manager
): Promise<PmRefusal | null> {
	return (await holds(db, mayManageProject(projectId, actor)))
		? null
		: { ok: false, reason: 'forbidden' };
}

/** SQL: `taskId` is a live task of the project. */
export const liveTask = (projectId: string, taskId: string) =>
	sql`exists (select 1 from tasks t where t.id = ${taskId} and t.project_id = ${projectId} and t.deleted_at is null)`;

/** True when the SQL condition holds right now (a refusal's follow-up read). */
export async function holds(db: Db, condition: ReturnType<typeof sql>): Promise<boolean> {
	const row = await db
		.select({ ok: sql<number>`1` })
		.from(sql`(select 1)`)
		.where(condition)
		.get();
	return !!row;
}
