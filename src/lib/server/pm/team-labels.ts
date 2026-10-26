import { and, asc, eq, isNull, sql, type SQLWrapper } from 'drizzle-orm';
import type { LabelColor } from '#lib/shared/enums';
import type { SessionUser } from '../auth/session';
import { isActiveAdmin } from '../auth/invites';
import type { Db } from '../db';
import { taskTeamLabels, teamLabels } from '../db/schema';
import { isUniqueViolation, newId } from '../util';
import { holds, inTaskIds, type PmWrite, type TaskIdSet } from './common';
import { PM_LIMITS, PM_MESSAGES, type LabelInput } from './validation';

/**
 * Team labels (RB-12): workspace labels, usable on a task of any project, next to RB-08's project labels. Only admins
 * create, rename, recolour and delete them (owner decision O1); the routes call requireAdmin and every write also
 * checks, inside its own statement, that the actor is still an active admin. Any active user applies them. The
 * partial unique index `team_labels_name_uq` decides a name clash (case-insensitive through `name_key`), and the
 * 100-label cap is a count inside the INSERT. Deleting is soft; links stay, every read filters live labels, and the
 * name becomes free.
 */

type Actor = Pick<SessionUser, 'id'>;

export interface TeamLabel {
	id: string;
	name: string;
	color: LabelColor;
	updatedAt: number;
}

/** Every live team label by name (at most PM_LIMITS.teamLabelsMax exist). A batch item or awaited alone. */
export function listTeamLabelsQuery(db: Db) {
	return db
		.select({
			id: teamLabels.id,
			name: teamLabels.name,
			color: teamLabels.color,
			updatedAt: teamLabels.updatedAt
		})
		.from(teamLabels)
		.where(isNull(teamLabels.deletedAt))
		.orderBy(asc(teamLabels.nameKey))
		.limit(PM_LIMITS.teamLabelsMax * 2);
}

export async function listTeamLabels(db: Db): Promise<TeamLabel[]> {
	return listTeamLabelsQuery(db);
}

const liveCount = sql`(select count(*) from team_labels tl where tl.deleted_at is null)`;

export async function createTeamLabel(
	db: Db,
	actor: Actor,
	input: LabelInput,
	at: number
): Promise<PmWrite<{ id: string }>> {
	const id = newId();
	try {
		const rows = await db
			.insert(teamLabels)
			.select(
				db
					.select({
						id: sql`${id}`.as('id'),
						name: sql`${input.name}`.as('name'),
						nameKey: sql`${input.nameKey}`.as('nameKey'),
						color: sql`${input.color}`.as('color'),
						createdBy: sql`${actor.id}`.as('createdBy'),
						createdAt: sql`${at}`.as('createdAt'),
						updatedAt: sql`${at}`.as('updatedAt'),
						deletedAt: sql`null`.as('deletedAt')
					})
					.from(sql`(select 1)`)
					.where(and(isActiveAdmin(actor.id), sql`${liveCount} < ${PM_LIMITS.teamLabelsMax}`))
			)
			.returning({ id: teamLabels.id });
		if (rows.length === 1) return { ok: true, id };
	} catch (e) {
		if (isUniqueViolation(e))
			return { ok: false, reason: 'duplicate', message: PM_MESSAGES.teamLabelTaken };
		throw e;
	}
	if (!(await holds(db, isActiveAdmin(actor.id)))) return { ok: false, reason: 'forbidden' };
	return { ok: false, reason: 'limit', message: PM_MESSAGES.teamLabelLimit };
}

/** Rename and recolour against the version the form showed. */
export async function updateTeamLabel(
	db: Db,
	actor: Actor,
	id: string,
	input: LabelInput,
	expected: number,
	at: number
): Promise<PmWrite> {
	try {
		const rows = await db
			.update(teamLabels)
			.set({
				name: input.name,
				nameKey: input.nameKey,
				color: input.color,
				updatedAt: Math.max(at, expected + 1)
			})
			.where(
				and(
					eq(teamLabels.id, id),
					isNull(teamLabels.deletedAt),
					eq(teamLabels.updatedAt, expected),
					isActiveAdmin(actor.id)
				)
			)
			.returning({ id: teamLabels.id });
		if (rows.length === 1) return { ok: true };
	} catch (e) {
		if (isUniqueViolation(e))
			return { ok: false, reason: 'duplicate', message: PM_MESSAGES.teamLabelTaken };
		throw e;
	}
	const row = await db
		.select({ updatedAt: teamLabels.updatedAt })
		.from(teamLabels)
		.where(and(eq(teamLabels.id, id), isNull(teamLabels.deletedAt)))
		.get();
	if (!row) return { ok: false, reason: 'not_found' };
	if (!(await holds(db, isActiveAdmin(actor.id)))) return { ok: false, reason: 'forbidden' };
	return { ok: false, reason: 'conflict', message: PM_MESSAGES.changed };
}

/** Soft delete: the label leaves every filter, chip and picker; its name becomes free. Already deleted is done. */
export async function deleteTeamLabel(
	db: Db,
	actor: Actor,
	id: string,
	at: number
): Promise<PmWrite> {
	const rows = await db
		.update(teamLabels)
		.set({ deletedAt: at, updatedAt: at })
		.where(and(eq(teamLabels.id, id), isNull(teamLabels.deletedAt), isActiveAdmin(actor.id)))
		.returning({ id: teamLabels.id });
	if (rows.length === 1) return { ok: true };
	if (!(await holds(db, isActiveAdmin(actor.id)))) return { ok: false, reason: 'forbidden' };
	const exists = await holds(db, sql`exists (select 1 from team_labels tl where tl.id = ${id})`);
	return exists ? { ok: true } : { ok: false, reason: 'not_found' };
}

/**
 * How many live tasks of live projects carry each live team label (the "Used on N tasks" of the admin page), as one
 * grouped count. A batch item or awaited alone.
 */
export function teamLabelUsageQuery(db: Db) {
	return db
		.select({ id: taskTeamLabels.teamLabelId, n: sql<number>`count(*)` })
		.from(taskTeamLabels)
		.innerJoin(teamLabels, eq(teamLabels.id, taskTeamLabels.teamLabelId))
		.innerJoin(sql`tasks t`, sql`t.id = ${taskTeamLabels.taskId} and t.deleted_at is null`)
		.innerJoin(sql`projects p`, sql`p.id = t.project_id and p.deleted_at is null`)
		.where(isNull(teamLabels.deletedAt))
		.groupBy(taskTeamLabels.teamLabelId);
}

/**
 * The live team labels of the given tasks, by name; the ids are bound once as JSON (D1's 100-parameter limit). A
 * batch item: run it next to labelsForTasksQuery.
 */
export function teamLabelsForTasksQuery(db: Db, taskIds: TaskIdSet) {
	return db
		.select({
			taskId: taskTeamLabels.taskId,
			id: teamLabels.id,
			name: teamLabels.name,
			color: teamLabels.color
		})
		.from(taskTeamLabels)
		.innerJoin(teamLabels, eq(teamLabels.id, taskTeamLabels.teamLabelId))
		.where(and(inTaskIds(taskTeamLabels.taskId, taskIds), isNull(teamLabels.deletedAt)))
		.orderBy(asc(teamLabels.nameKey));
}

/**
 * SQL over a task id expression: how many live labels (project and team) the task carries now. The combined cap
 * (owner decision O6) is checked with it inside each INSERT, so concurrent adds never pass 10.
 */
export const liveLabelCount = (taskId: SQLWrapper | string) =>
	sql`((select count(*) from task_labels xl join labels xll on xll.id = xl.label_id where xl.task_id = ${taskId} and xll.deleted_at is null) + (select count(*) from task_team_labels xt join team_labels xtl on xtl.id = xt.team_label_id where xt.task_id = ${taskId} and xtl.deleted_at is null))`;
