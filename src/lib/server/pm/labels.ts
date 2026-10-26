import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { LabelColor } from '#lib/shared/enums';
import type { SessionUser } from '../auth/session';
import type { Db } from '../db';
import { batchAssert, isBatchAssertFailure } from '../db/assert';
import { labels, taskLabels } from '../db/schema';
import { projectActive } from '../tasks/repo';
import { isUniqueViolation, newId } from '../util';
import {
	holds,
	liveTask,
	managerRefusal,
	mayManageProject,
	projectRefusal,
	type Manager,
	type PmWrite
} from './common';
import { PM_LIMITS, PM_MESSAGES, type LabelInput } from './validation';

/**
 * Labels of a project (RB-08). Writes are single guarded statements: the project must be active when they run, the
 * partial unique index `labels_project_name_uq` decides a name clash (case-insensitive through `name_key`), and the
 * 30-label cap is a count inside the INSERT. Deleting is soft; links stay but every read filters live labels.
 */

type Actor = Pick<SessionUser, 'id'>;

export interface Label {
	id: string;
	name: string;
	color: LabelColor;
	createdBy: string;
	updatedAt: number;
}

/** The project's live labels by name. */
export async function listLabels(db: Db, projectId: string): Promise<Label[]> {
	return db
		.select({
			id: labels.id,
			name: labels.name,
			color: labels.color,
			createdBy: labels.createdBy,
			updatedAt: labels.updatedAt
		})
		.from(labels)
		.where(and(eq(labels.projectId, projectId), isNull(labels.deletedAt)))
		.orderBy(asc(labels.nameKey))
		.limit(PM_LIMITS.labelsPerProject * 2);
}

const liveCount = (projectId: string) =>
	sql`(select count(*) from labels l where l.project_id = ${projectId} and l.deleted_at is null)`;

export async function createLabel(
	db: Db,
	actor: Actor,
	projectId: string,
	input: LabelInput,
	at: number
): Promise<PmWrite<{ id: string }>> {
	const id = newId();
	try {
		const rows = await db
			.insert(labels)
			.select(
				db
					.select({
						id: sql`${id}`.as('id'),
						projectId: sql`${projectId}`.as('projectId'),
						name: sql`${input.name}`.as('name'),
						nameKey: sql`${input.nameKey}`.as('nameKey'),
						color: sql`${input.color}`.as('color'),
						createdBy: sql`${actor.id}`.as('createdBy'),
						createdAt: sql`${at}`.as('createdAt'),
						updatedAt: sql`${at}`.as('updatedAt'),
						deletedAt: sql`null`.as('deletedAt')
					})
					.from(sql`(select 1)`)
					.where(
						and(
							projectActive(projectId),
							sql`${liveCount(projectId)} < ${PM_LIMITS.labelsPerProject}`
						)
					)
			)
			.returning({ id: labels.id });
		if (rows.length === 1) return { ok: true, id };
	} catch (e) {
		if (isUniqueViolation(e))
			return { ok: false, reason: 'duplicate', message: PM_MESSAGES.labelTaken };
		throw e;
	}
	return (
		(await projectRefusal(db, projectId)) ?? {
			ok: false,
			reason: 'limit',
			message: PM_MESSAGES.labelLimit
		}
	);
}

/** Why a label write found nothing: gone, the project, the manager rule (forbidden) or a newer version. */
async function labelRefusal(
	db: Db,
	projectId: string,
	id: string,
	actor: Manager,
	expected: number
) {
	const row = await db
		.select({ updatedAt: labels.updatedAt })
		.from(labels)
		.where(and(eq(labels.id, id), eq(labels.projectId, projectId), isNull(labels.deletedAt)))
		.get();
	if (!row) return { ok: false as const, reason: 'not_found' as const };
	const project =
		(await projectRefusal(db, projectId)) ?? (await managerRefusal(db, projectId, actor));
	if (project) return project;
	if (row.updatedAt !== expected)
		return { ok: false as const, reason: 'conflict' as const, message: PM_MESSAGES.changed };
	return { ok: false as const, reason: 'conflict' as const, message: PM_MESSAGES.stale };
}

/** Rename and recolour (managers only, checked inside the statement), against the version the form showed. */
export async function updateLabel(
	db: Db,
	actor: Manager,
	projectId: string,
	id: string,
	input: LabelInput,
	expected: number,
	at: number
): Promise<PmWrite> {
	try {
		const rows = await db
			.update(labels)
			.set({
				name: input.name,
				nameKey: input.nameKey,
				color: input.color,
				updatedAt: Math.max(at, expected + 1)
			})
			.where(
				and(
					eq(labels.id, id),
					eq(labels.projectId, projectId),
					isNull(labels.deletedAt),
					eq(labels.updatedAt, expected),
					projectActive(projectId),
					mayManageProject(projectId, actor)
				)
			)
			.returning({ id: labels.id });
		if (rows.length === 1) return { ok: true };
	} catch (e) {
		if (isUniqueViolation(e))
			return { ok: false, reason: 'duplicate', message: PM_MESSAGES.labelTaken };
		throw e;
	}
	return labelRefusal(db, projectId, id, actor, expected);
}

/**
 * Soft delete (managers only, checked inside the statement): the label leaves filters and cards and its name
 * becomes free. Already deleted counts as done.
 */
export async function deleteLabel(
	db: Db,
	actor: Manager,
	projectId: string,
	id: string,
	at: number
): Promise<PmWrite> {
	const rows = await db
		.update(labels)
		.set({ deletedAt: at, updatedAt: at })
		.where(
			and(
				eq(labels.id, id),
				eq(labels.projectId, projectId),
				isNull(labels.deletedAt),
				projectActive(projectId),
				mayManageProject(projectId, actor)
			)
		)
		.returning({ id: labels.id });
	if (rows.length === 1) return { ok: true };
	const refused =
		(await projectRefusal(db, projectId)) ?? (await managerRefusal(db, projectId, actor));
	if (refused) return refused;
	const exists = await holds(
		db,
		sql`exists (select 1 from labels l where l.id = ${id} and l.project_id = ${projectId})`
	);
	return exists ? { ok: true } : { ok: false, reason: 'not_found' };
}

/**
 * Replaces a task's label set (at most PM_LIMITS.labelsPerTask, checked by the parser) in one batch: an assertion
 * that the task is live, the project active and every id a live label of this project, then the unlinks and the
 * links. Any refusal rolls the whole batch back. Last write wins between two tabs (a tag set has no merge); the
 * task's `updated_at` is not touched (owner decision 8).
 */
export async function setTaskLabels(
	db: Db,
	projectId: string,
	taskId: string,
	labelIds: string[],
	at: number
): Promise<PmWrite> {
	if (labelIds.length > PM_LIMITS.labelsPerTask)
		return { ok: false, reason: 'limit', message: PM_MESSAGES.labelsPerTask };
	const ids = JSON.stringify(labelIds);
	const matching = sql`(select count(*) from labels l where l.id in (select value from json_each(${ids})) and l.project_id = ${projectId} and l.deleted_at is null)`;
	try {
		await db.batch([
			batchAssert(
				db,
				sql`${liveTask(projectId, taskId)} and ${projectActive(projectId)} and ${matching} = ${labelIds.length}`
			),
			db
				.delete(taskLabels)
				.where(
					and(
						eq(taskLabels.taskId, taskId),
						sql`${taskLabels.labelId} not in (select value from json_each(${ids}))`
					)
				),
			db
				.insert(taskLabels)
				.select(
					db
						.select({
							taskId: sql`${taskId}`.as('taskId'),
							labelId: labels.id,
							createdAt: sql`${at}`.as('createdAt')
						})
						.from(labels)
						.where(
							and(
								sql`${labels.id} in (select value from json_each(${ids}))`,
								eq(labels.projectId, projectId),
								isNull(labels.deletedAt)
							)
						)
				)
				.onConflictDoNothing()
		]);
		return { ok: true };
	} catch (e) {
		if (!isBatchAssertFailure(e)) throw e;
	}
	if (!(await holds(db, liveTask(projectId, taskId)))) return { ok: false, reason: 'not_found' };
	return (
		(await projectRefusal(db, projectId)) ?? {
			ok: false,
			reason: 'invalid',
			message: PM_MESSAGES.labelUnknown
		}
	);
}

export type TaskLabel = { id: string; name: string; color: LabelColor };

/**
 * The live labels of the given tasks, by name; the ids are bound once as JSON (D1's 100-parameter limit) and a
 * label counts only on a task of its own project. A batch item: run it with the other per-task lookups.
 */
export function labelsForTasksQuery(db: Db, taskIds: readonly string[]) {
	return db
		.select({ taskId: taskLabels.taskId, id: labels.id, name: labels.name, color: labels.color })
		.from(taskLabels)
		.innerJoin(labels, eq(labels.id, taskLabels.labelId))
		.innerJoin(
			sql`tasks t`,
			sql`t.id = ${taskLabels.taskId} and t.project_id = ${labels.projectId}`
		)
		.where(
			and(
				sql`${taskLabels.taskId} in (select value from json_each(${JSON.stringify(taskIds)}))`,
				isNull(labels.deletedAt)
			)
		)
		.orderBy(asc(labels.nameKey));
}
