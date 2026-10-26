import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { SessionUser } from '../auth/session';
import type { Db } from '../db';
import { batchAssert, isBatchAssertFailure } from '../db/assert';
import { notifications, reminders, taskLabels, tasks, taskTeamLabels } from '../db/schema';
import { POSITION_STEP } from '../tasks/position';
import { completedAtFor, milestoneAssignable, projectActive } from '../tasks/repo';
import { holds, projectRefusal, type PmWrite } from './common';
import { liveLabelCount } from './team-labels';
import { PM_LIMITS, PM_MESSAGES, type BulkChanges } from './validation';

/**
 * Bulk edit of up to 100 tasks in one `db.batch`, all or nothing: of one project (RB-08, `bulkUpdate`) or across
 * projects (RB-12, `issuesBulkUpdate`), through one core. The first item asserts that every id is a live task (of
 * this project, or of any active live project) and every referenced row (assignee, milestone, labels) is valid; a
 * failure rolls the batch back and nothing is written. Bulk is last-writer-wins: there is no per-task version check
 * (the UI says so). The ids are bound once as JSON (D1's 100-parameter limit).
 */

type Actor = Pick<SessionUser, 'id'>;

/** SQL: a random version-4 UUID per row (a notification id written by a set-based INSERT). */
const randomUuid = sql`lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))`;

export type BulkResult = PmWrite<{
	updated: number;
	labelCapped: number;
	/** Tasks that would have notified their new assignee beyond the first PM_LIMITS.bulkNotifyMax (0: none). */
	notifySkipped: number;
}>;

/** One project's bulk edit (RB-08): every id must be a live task of this project, and the project active. */
export function bulkUpdate(
	db: Db,
	actor: Actor,
	projectId: string,
	taskIds: readonly string[],
	changes: BulkChanges,
	at: number
): Promise<BulkResult> {
	return bulkCore(db, actor, projectId, taskIds, changes, at);
}

/**
 * The Issues page's bulk edit (RB-12 D6): tasks of any projects, each of which must be active and live. Milestones
 * and project labels are refused (they belong to one project). A missing or deleted id answers `not_found`, a task
 * of an archived project `archived`; either way nothing is written.
 */
export function issuesBulkUpdate(
	db: Db,
	actor: Actor,
	taskIds: readonly string[],
	changes: BulkChanges,
	at: number
): Promise<BulkResult> {
	if (
		changes.milestoneId !== undefined ||
		changes.addLabelId !== undefined ||
		changes.removeLabelId !== undefined
	)
		return Promise.resolve({ ok: false, reason: 'invalid', message: PM_MESSAGES.stale });
	return bulkCore(db, actor, null, taskIds, changes, at);
}

/** Answer of an Issues bulk whose ids are all live tasks, some in archived projects. */
export const BULK_ARCHIVED = 'Some selected tasks are in archived projects.';

async function bulkCore(
	db: Db,
	actor: Actor,
	projectId: string | null,
	taskIds: readonly string[],
	changes: BulkChanges,
	at: number
): Promise<BulkResult> {
	if (taskIds.length === 0 || taskIds.length > PM_LIMITS.bulkMax)
		return { ok: false, reason: 'invalid', message: PM_MESSAGES.bulkTooMany };
	const ids = JSON.stringify(taskIds);
	/** SQL over alias `t`: one of the selected ids, a live task of this project (or of an active live project). */
	const selected = () =>
		projectId !== null
			? sql`t.project_id = ${projectId} and t.deleted_at is null and t.id in (select value from json_each(${ids}))`
			: sql`t.deleted_at is null and t.id in (select value from json_each(${ids})) and exists (select 1 from projects sp where sp.id = t.project_id and sp.status = 'active' and sp.deleted_at is null)`;
	const selectedTasks = and(
		projectId !== null
			? eq(tasks.projectId, projectId)
			: sql`exists (select 1 from projects sp where sp.id = ${tasks.projectId} and sp.status = 'active' and sp.deleted_at is null)`,
		isNull(tasks.deletedAt),
		sql`${tasks.id} in (select value from json_each(${ids}))`
	);

	const {
		status,
		priority,
		type,
		assigneeId,
		milestoneId,
		dueOn,
		addLabelId,
		removeLabelId,
		addTeamLabelId,
		removeTeamLabelId
	} = changes;
	const scoped = projectId ?? '';
	const checks = {
		tasks: sql`(select count(*) from tasks t where ${selected()}) = ${taskIds.length}`,
		assigneeId: assigneeId
			? sql`exists (select 1 from users u where u.id = ${assigneeId} and u.status = 'active')`
			: null,
		milestoneId: milestoneId ? milestoneAssignable(scoped, milestoneId) : null,
		addLabelId: addLabelId
			? sql`exists (select 1 from labels l where l.id = ${addLabelId} and l.project_id = ${scoped} and l.deleted_at is null)`
			: null,
		removeLabelId: removeLabelId
			? sql`exists (select 1 from labels l where l.id = ${removeLabelId} and l.project_id = ${scoped})`
			: null,
		addTeamLabelId: addTeamLabelId
			? sql`exists (select 1 from team_labels tl where tl.id = ${addTeamLabelId} and tl.deleted_at is null)`
			: null,
		removeTeamLabelId: removeTeamLabelId
			? sql`exists (select 1 from team_labels tl where tl.id = ${removeTeamLabelId})`
			: null
	};
	const guard = [
		...(projectId !== null ? [projectActive(projectId)] : []),
		...Object.values(checks).filter((c): c is SQL => !!c)
	];

	const fields: Record<string, unknown> = {};
	if (priority !== undefined) fields.priority = priority;
	if (type !== undefined) fields.type = type;
	if (assigneeId !== undefined) fields.assigneeId = assigneeId;
	if (milestoneId !== undefined) fields.milestoneId = milestoneId;
	if (dueOn !== undefined) fields.dueOn = dueOn;
	const bump = sql`max(${at}, ${tasks.updatedAt} + 1)`;
	/** SQL: the task has room for one more label (project and team labels count together; owner decision O6). */
	const underCap = sql`${liveLabelCount(tasks.id)} < ${PM_LIMITS.labelsPerTask}`;

	const items: BatchItem<'sqlite'>[] = [];
	/** Index (in the batch results) of the count of tasks that would notify, when an assignee is set. */
	let candidatesAt = -1;
	// Notifications first, while the old assignee is still stored: only tasks whose assignee really changes, no
	// second unread one per task (the RB-01 dedupe), and at most PM_LIMITS.bulkNotifyMax per request (red team L2:
	// the assignments beyond it still apply, silently).
	const notifyWhere =
		assigneeId && assigneeId !== actor.id
			? and(
					selectedTasks,
					sql`(${tasks.assigneeId} is null or ${tasks.assigneeId} <> ${assigneeId})`,
					sql`not exists (select 1 from notifications n where n.user_id = ${assigneeId} and n.kind = 'assigned' and n.target_kind = 'task' and n.target_id = ${tasks.id} and n.read_at is null)`
				)
			: null;
	if (assigneeId && notifyWhere) {
		candidatesAt = items.length + 1;
		items.push(
			db
				.select({ n: sql<number>`count(*)` })
				.from(tasks)
				.where(notifyWhere)
		);
		items.push(
			db.insert(notifications).select(
				db
					.select({
						id: randomUuid.as('id'),
						userId: sql`${assigneeId}`.as('userId'),
						kind: sql`'assigned'`.as('kind'),
						actorId: sql`${actor.id}`.as('actorId'),
						targetKind: sql`'task'`.as('targetKind'),
						targetId: tasks.id,
						commentId: sql`null`.as('commentId'),
						summary: sql`null`.as('summary'),
						reminderId: sql`null`.as('reminderId'),
						occurrenceAt: sql`null`.as('occurrenceAt'),
						createdAt: sql`${at}`.as('createdAt'),
						readAt: sql`null`.as('readAt')
					})
					.from(tasks)
					.where(notifyWhere)
					.orderBy(asc(tasks.number))
					.limit(PM_LIMITS.bulkNotifyMax)
			)
		);
	}
	if (status !== undefined) {
		// Tasks entering the column go to its bottom in ascending number order. Both the base (the column's bottom
		// without the selected tasks) and the rank (by number among the selected ids) ignore the rows this
		// statement changes, so the result does not depend on the order SQLite visits them.
		// RB-12: across projects each task goes to the bottom of its own project's column, ranked within that project.
		const base = sql`(select coalesce(max(t.position), 0) from tasks t where t.project_id = ${tasks.projectId} and t.status = ${status} and t.deleted_at is null and t.id not in (select value from json_each(${ids})))`;
		const rank = sql`(select count(*) from tasks t where ${selected()} and t.project_id = ${tasks.projectId} and t.number <= ${tasks.number})`;
		items.push(
			db
				.update(tasks)
				.set({
					status,
					position: sql`${base} + ${rank} * ${POSITION_STEP}`,
					completedAt: completedAtFor(status, at),
					updatedAt: bump
				})
				.where(and(selectedTasks, sql`${tasks.status} <> ${status}`))
		);
	}
	if (Object.keys(fields).length > 0)
		items.push(
			db
				.update(tasks)
				.set({ ...fields, updatedAt: bump })
				.where(selectedTasks)
		);
	// RB-09: a changed due date sends the selected tasks' relative reminders back to the jobs Worker to re-derive.
	if (dueOn !== undefined)
		items.push(
			db
				.update(reminders)
				.set({
					fireAt: at,
					claimToken: null,
					claimUntil: null,
					retryAt: null,
					attempts: 0,
					updatedAt: at
				})
				.where(
					and(
						eq(reminders.targetKind, 'task'),
						eq(reminders.mode, 'relative'),
						isNull(reminders.doneAt),
						isNull(reminders.deletedAt),
						sql`${reminders.targetId} in (select t.id from tasks t where ${selected()})`
					)
				)
		);
	if (addLabelId)
		items.push(
			db
				.insert(taskLabels)
				.select(
					db
						.select({
							taskId: tasks.id,
							labelId: sql`${addLabelId}`.as('labelId'),
							createdAt: sql`${at}`.as('createdAt')
						})
						.from(tasks)
						.where(and(selectedTasks, underCap))
				)
				.onConflictDoNothing()
		);
	if (removeLabelId)
		items.push(
			db
				.delete(taskLabels)
				.where(
					and(
						eq(taskLabels.labelId, removeLabelId),
						sql`${taskLabels.taskId} in (select t.id from tasks t where ${selected()})`
					)
				)
		);
	if (addTeamLabelId)
		items.push(
			db
				.insert(taskTeamLabels)
				.select(
					db
						.select({
							taskId: tasks.id,
							teamLabelId: sql`${addTeamLabelId}`.as('teamLabelId'),
							createdAt: sql`${at}`.as('createdAt')
						})
						.from(tasks)
						.where(and(selectedTasks, underCap))
				)
				.onConflictDoNothing()
		);
	if (removeTeamLabelId)
		items.push(
			db
				.delete(taskTeamLabels)
				.where(
					and(
						eq(taskTeamLabels.teamLabelId, removeTeamLabelId),
						sql`${taskTeamLabels.taskId} in (select t.id from tasks t where ${selected()})`
					)
				)
		);
	// How many selected tasks still lack an added label: those already at the 10-label cap.
	const lacks = [
		addLabelId
			? sql`not exists (select 1 from task_labels tl where tl.task_id = t.id and tl.label_id = ${addLabelId})`
			: null,
		addTeamLabelId
			? sql`not exists (select 1 from task_team_labels tt where tt.task_id = t.id and tt.team_label_id = ${addTeamLabelId})`
			: null
	].filter((c): c is SQL => !!c);
	const capped = db
		.select({
			n:
				lacks.length > 0
					? sql<number>`(select count(*) from tasks t where ${selected()} and (${sql.join(lacks, sql` or `)}))`
					: sql<number>`0`
		})
		.from(sql`(select 1)`);

	try {
		const results = await db.batch([
			batchAssert(db, and(...guard) as SQL),
			...items,
			capped
		] as unknown as Parameters<Db['batch']>[0]);
		const last = results[results.length - 1] as { n: number }[];
		const candidates =
			candidatesAt < 0 ? 0 : Number((results[candidatesAt] as { n: number }[])[0]?.n ?? 0);
		return {
			ok: true,
			updated: taskIds.length,
			labelCapped: Number(last[0]?.n ?? 0),
			notifySkipped: Math.max(0, candidates - PM_LIMITS.bulkNotifyMax)
		};
	} catch (e) {
		if (!isBatchAssertFailure(e)) throw e;
	}
	if (projectId !== null) {
		const refused = await projectRefusal(db, projectId);
		if (refused) return refused;
	}
	if (!(await holds(db, checks.tasks))) {
		// Across projects: every id is a live task of a live project, so some project is archived (409, not 404).
		const allLive =
			projectId === null &&
			(await holds(
				db,
				sql`(select count(*) from tasks t join projects lp on lp.id = t.project_id where t.deleted_at is null and lp.deleted_at is null and t.id in (select value from json_each(${ids}))) = ${taskIds.length}`
			));
		return allLive
			? { ok: false, reason: 'archived', message: BULK_ARCHIVED }
			: { ok: false, reason: 'not_found', message: PM_MESSAGES.bulkGone };
	}
	const errors: Record<string, string> = {};
	if (checks.assigneeId && !(await holds(db, checks.assigneeId)))
		errors.assigneeId = 'Choose an active teammate or nobody.';
	if (checks.milestoneId && !(await holds(db, checks.milestoneId)))
		errors.milestoneId = 'Choose an open milestone of this project or none.';
	if (checks.addLabelId && !(await holds(db, checks.addLabelId)))
		errors.addLabelId = PM_MESSAGES.labelUnknown;
	if (checks.removeLabelId && !(await holds(db, checks.removeLabelId)))
		errors.removeLabelId = PM_MESSAGES.labelUnknown;
	if (checks.addTeamLabelId && !(await holds(db, checks.addTeamLabelId)))
		errors.addTeamLabelId = PM_MESSAGES.teamLabelUnknown;
	if (checks.removeTeamLabelId && !(await holds(db, checks.removeTeamLabelId)))
		errors.removeTeamLabelId = PM_MESSAGES.teamLabelUnknown;
	return { ok: false, reason: 'invalid', message: PM_MESSAGES.stale, errors };
}
