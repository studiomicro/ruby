import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { CLOSED_TASK_STATUSES, type ProjectStatus } from '#lib/shared/enums';
import type { SessionUser } from '../auth/session';
import type { Db } from '../db';
import { projects, tasks, users } from '../db/schema';
import { isUniqueViolation, newId } from '../util';
import { LIMITS } from '../tasks/validation';
import { PROJECT_MESSAGES, type ProjectFields } from './validation';

/**
 * Projects: every active user sees every live project (`deleted_at IS NULL`; there is no project delete in RB-01,
 * the filter is kept anyway). Writes are guarded statements: the lead must be an active user when the statement
 * runs, an edit applies only to the version it was made from (`updated_at = expected`), and edit/archive rights
 * (lead, creator, admin) are part of the WHERE clause, not only checked before it.
 */

type Actor = Pick<SessionUser, 'id' | 'role'>;

export const CLOSED_STATUS_LIST = [...CLOSED_TASK_STATUSES];
const closedJson = JSON.stringify(CLOSED_STATUS_LIST);

const projectColumns = {
	id: projects.id,
	key: projects.key,
	name: projects.name,
	description: projects.description,
	status: projects.status,
	leadId: projects.leadId,
	leadName: users.name,
	createdBy: projects.createdBy,
	createdAt: projects.createdAt,
	updatedAt: projects.updatedAt
};

export type Project = {
	id: string;
	key: string;
	name: string;
	description: string;
	status: ProjectStatus;
	leadId: string | null;
	leadName: string | null;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
};

/** SQL: `id` is null or names an active user. */
export const activeUserOrNone = (id: string | null) =>
	sql`(${id} is null or exists (select 1 from users u where u.id = ${id} and u.status = 'active'))`;

/** SQL: the actor may edit or archive the project row the statement touches. */
const mayManage = (actor: Actor) =>
	actor.role === 'admin'
		? sql`1 = 1`
		: sql`(${projects.leadId} = ${actor.id} or ${projects.createdBy} = ${actor.id})`;

/** Active (default) or archived projects, by key, bounded by LIMITS.projectListMax. */
export async function listProjects(db: Db, options: { archived: boolean }): Promise<Project[]> {
	return db
		.select(projectColumns)
		.from(projects)
		.leftJoin(users, eq(users.id, projects.leadId))
		.where(
			and(eq(projects.status, options.archived ? 'archived' : 'active'), isNull(projects.deletedAt))
		)
		.orderBy(asc(projects.key))
		.limit(LIMITS.projectListMax);
}

/** Open (not done/canceled, not deleted) task counts per project id; the id list is bound once as JSON. */
export async function projectOpenCounts(
	db: Db,
	projectIds: string[]
): Promise<Map<string, number>> {
	if (projectIds.length === 0) return new Map();
	const rows = await db
		.select({ projectId: tasks.projectId, n: sql<number>`count(*)` })
		.from(tasks)
		.where(
			and(
				sql`${tasks.projectId} in (select value from json_each(${JSON.stringify(projectIds)}))`,
				isNull(tasks.deletedAt),
				sql`${tasks.status} not in (select value from json_each(${closedJson}))`
			)
		)
		.groupBy(tasks.projectId);
	return new Map(rows.map((r) => [r.projectId, Number(r.n)]));
}

/** A live project by its (upper-case) key, or null. */
export async function getProjectByKey(db: Db, key: string): Promise<Project | null> {
	const row = await db
		.select(projectColumns)
		.from(projects)
		.leftJoin(users, eq(users.id, projects.leadId))
		.where(and(eq(projects.key, key), isNull(projects.deletedAt)))
		.get();
	return row ?? null;
}

async function getProjectById(db: Db, id: string) {
	return db
		.select({
			status: projects.status,
			leadId: projects.leadId,
			updatedAt: projects.updatedAt,
			deletedAt: projects.deletedAt
		})
		.from(projects)
		.where(eq(projects.id, id))
		.get();
}

async function isActiveUser(db: Db, id: string): Promise<boolean> {
	const row = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.id, id), eq(users.status, 'active')))
		.get();
	return !!row;
}

export type ProjectWrite =
	| { ok: true }
	| {
			ok: false;
			reason: 'invalid' | 'not_found' | 'conflict' | 'forbidden';
			errors?: Partial<Record<'key' | 'leadId' | 'form', string>>;
	  };

/** Creates a project; a taken key or an inactive lead come back as field errors, never as a 500. */
export async function createProject(
	db: Db,
	actor: Actor,
	input: ProjectFields & { key: string },
	at: number
): Promise<ProjectWrite> {
	const id = newId();
	try {
		const rows = await db
			.insert(projects)
			.select(
				db
					.select({
						id: sql`${id}`.as('id'),
						key: sql`${input.key}`.as('key'),
						name: sql`${input.name}`.as('name'),
						description: sql`${input.description}`.as('description'),
						status: sql`'active'`.as('status'),
						leadId: sql`${input.leadId}`.as('leadId'),
						nextTaskNumber: sql`1`.as('nextTaskNumber'),
						createdBy: sql`${actor.id}`.as('createdBy'),
						createdAt: sql`${at}`.as('createdAt'),
						updatedAt: sql`${at}`.as('updatedAt'),
						deletedAt: sql`null`.as('deletedAt')
					})
					.from(sql`(select 1)`)
					.where(activeUserOrNone(input.leadId))
			)
			.returning({ id: projects.id });
		if (rows.length === 1) return { ok: true };
		return { ok: false, reason: 'invalid', errors: { leadId: PROJECT_MESSAGES.lead } };
	} catch (e) {
		if (isUniqueViolation(e))
			return { ok: false, reason: 'invalid', errors: { key: PROJECT_MESSAGES.keyTaken } };
		throw e;
	}
}

/** Why a guarded project write changed nothing. */
async function projectRefusal(
	db: Db,
	projectId: string,
	expected: number,
	leadId: string | null | undefined
): Promise<ProjectWrite> {
	const current = await getProjectById(db, projectId);
	if (!current || current.deletedAt !== null) return { ok: false, reason: 'not_found' };
	if (current.updatedAt !== expected) return { ok: false, reason: 'conflict' };
	if (leadId && leadId !== current.leadId && !(await isActiveUser(db, leadId)))
		return { ok: false, reason: 'invalid', errors: { leadId: PROJECT_MESSAGES.lead } };
	return { ok: false, reason: 'forbidden' };
}

/**
 * Edits name, description and lead (the key is never written). A lead that is unchanged may be a now-disabled user;
 * a new lead must be active. Only against the version the form was made from.
 */
export async function updateProject(
	db: Db,
	actor: Actor,
	projectId: string,
	input: ProjectFields,
	expected: number,
	at: number
): Promise<ProjectWrite> {
	const rows = await db
		.update(projects)
		.set({
			name: input.name,
			description: input.description,
			leadId: input.leadId,
			updatedAt: Math.max(at, expected + 1)
		})
		.where(
			and(
				eq(projects.id, projectId),
				isNull(projects.deletedAt),
				eq(projects.updatedAt, expected),
				mayManage(actor),
				sql`(${input.leadId} is null or ${input.leadId} = ${projects.leadId} or exists (select 1 from users u where u.id = ${input.leadId} and u.status = 'active'))`
			)
		)
		.returning({ id: projects.id });
	if (rows.length === 1) return { ok: true };
	return projectRefusal(db, projectId, expected, input.leadId);
}

/** Archives or unarchives (owner decision 2: an archived project is read-only for tasks). */
export async function setProjectArchived(
	db: Db,
	actor: Actor,
	projectId: string,
	archived: boolean,
	expected: number,
	at: number
): Promise<ProjectWrite> {
	const rows = await db
		.update(projects)
		.set({ status: archived ? 'archived' : 'active', updatedAt: Math.max(at, expected + 1) })
		.where(
			and(
				eq(projects.id, projectId),
				isNull(projects.deletedAt),
				eq(projects.updatedAt, expected),
				mayManage(actor)
			)
		)
		.returning({ id: projects.id });
	if (rows.length === 1) return { ok: true };
	return projectRefusal(db, projectId, expected, undefined);
}
