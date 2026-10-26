import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { SessionUser } from '../auth/session';
import type { Db } from '../db';
import { batchAssert, isBatchAssertFailure } from '../db/assert';
import { notifications, taskLabels, tasks } from '../db/schema';
import { POSITION_STEP } from '../tasks/position';
import { completedAtFor, milestoneAssignable, projectActive } from '../tasks/repo';
import { holds, projectRefusal, type PmWrite } from './common';
import { PM_LIMITS, PM_MESSAGES, type BulkChanges } from './validation';

/**
 * Bulk edit of up to 100 tasks of one project (RB-08) in one `db.batch`, all or nothing. The first item asserts
 * that every id is a live task of this project, the project is active and every referenced row (assignee,
 * milestone, labels) is valid; a failure rolls the batch back and nothing is written. Bulk is last-writer-wins:
 * there is no per-task version check (the UI says so). The ids are bound once as JSON (D1's 100-parameter limit).
 */

type Actor = Pick<SessionUser, 'id'>;

/** SQL: a random version-4 UUID per row (a notification id written by a set-based INSERT). */
const randomUuid = sql`lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))`;

export async function bulkUpdate(
	db: Db,
	actor: Actor,
	projectId: string,
	taskIds: readonly string[],
	changes: BulkChanges,
	at: number
): Promise<
	PmWrite<{
		updated: number;
		labelCapped: number;
		/** Tasks that would have notified their new assignee beyond the first PM_LIMITS.bulkNotifyMax (0: none). */
		notifySkipped: number;
	}>
> {
	if (taskIds.length === 0 || taskIds.length > PM_LIMITS.bulkMax)
		return { ok: false, reason: 'invalid', message: PM_MESSAGES.bulkTooMany };
	const ids = JSON.stringify(taskIds);
	/** SQL over alias `t`: one of the selected ids, a live task of this project. */
	const selected = () =>
		sql`t.project_id = ${projectId} and t.deleted_at is null and t.id in (select value from json_each(${ids}))`;
	const selectedTasks = and(
		eq(tasks.projectId, projectId),
		isNull(tasks.deletedAt),
		sql`${tasks.id} in (select value from json_each(${ids}))`
	);

	const { status, priority, assigneeId, milestoneId, dueOn, addLabelId, removeLabelId } = changes;
	const checks = {
		tasks: sql`(select count(*) from tasks t where ${selected()}) = ${taskIds.length}`,
		assigneeId: assigneeId
			? sql`exists (select 1 from users u where u.id = ${assigneeId} and u.status = 'active')`
			: null,
		milestoneId: milestoneId ? milestoneAssignable(projectId, milestoneId) : null,
		addLabelId: addLabelId
			? sql`exists (select 1 from labels l where l.id = ${addLabelId} and l.project_id = ${projectId} and l.deleted_at is null)`
			: null,
		removeLabelId: removeLabelId
			? sql`exists (select 1 from labels l where l.id = ${removeLabelId} and l.project_id = ${projectId})`
			: null
	};
	const guard = [projectActive(projectId), ...Object.values(checks).filter((c): c is SQL => !!c)];

	const fields: Record<string, unknown> = {};
	if (priority !== undefined) fields.priority = priority;
	if (assigneeId !== undefined) fields.assigneeId = assigneeId;
	if (milestoneId !== undefined) fields.milestoneId = milestoneId;
	if (dueOn !== undefined) fields.dueOn = dueOn;
	const bump = sql`max(${at}, ${tasks.updatedAt} + 1)`;

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
		const base = sql`(select coalesce(max(t.position), 0) from tasks t where t.project_id = ${projectId} and t.status = ${status} and t.deleted_at is null and t.id not in (select value from json_each(${ids})))`;
		const rank = sql`(select count(*) from tasks t where ${selected()} and t.number <= ${tasks.number})`;
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
						.where(
							and(
								selectedTasks,
								sql`(select count(*) from task_labels tl join labels l on l.id = tl.label_id where tl.task_id = ${tasks.id} and l.deleted_at is null) < ${PM_LIMITS.labelsPerTask}`
							)
						)
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
	// How many selected tasks still lack the added label: those already at the 10-label cap.
	const capped = db
		.select({
			n: addLabelId
				? sql<number>`(select count(*) from tasks t where ${selected()} and not exists (select 1 from task_labels tl where tl.task_id = t.id and tl.label_id = ${addLabelId}))`
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
	const refused = await projectRefusal(db, projectId);
	if (refused) return refused;
	if (!(await holds(db, checks.tasks)))
		return { ok: false, reason: 'not_found', message: PM_MESSAGES.bulkGone };
	const errors: Record<string, string> = {};
	if (checks.assigneeId && !(await holds(db, checks.assigneeId)))
		errors.assigneeId = 'Choose an active teammate or nobody.';
	if (checks.milestoneId && !(await holds(db, checks.milestoneId)))
		errors.milestoneId = 'Choose an open milestone of this project or none.';
	if (checks.addLabelId && !(await holds(db, checks.addLabelId)))
		errors.addLabelId = PM_MESSAGES.labelUnknown;
	if (checks.removeLabelId && !(await holds(db, checks.removeLabelId)))
		errors.removeLabelId = PM_MESSAGES.labelUnknown;
	return { ok: false, reason: 'invalid', message: PM_MESSAGES.stale, errors };
}
