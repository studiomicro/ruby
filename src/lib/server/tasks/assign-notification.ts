import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { notifications, tasks } from '../db/schema';
import { newId } from '../util';

/**
 * The `assigned` notification as a `db.batch` item, written in the same batch as the task write it reports, so
 * both succeed or neither does. It inserts a row only when, at that point of the batch, the task exists, is live,
 * has `assigneeId` as its assignee (and, when given, carries `updatedAt`, the version the write just stored), the
 * assignee is an active user, the assignee is not the actor (never notify oneself), and the assignee has no unread
 * `assigned` notification for this task yet (a reassign loop cannot flood one person's list; red team L2). RB-03
 * reads these rows.
 */
export function assignedNotificationStatement(
	db: Db,
	input: { taskId: string; assigneeId: string; actorId: string; now: number; updatedAt?: number }
) {
	return db.insert(notifications).select(
		db
			.select({
				id: sql`${newId()}`.as('id'),
				userId: sql`${input.assigneeId}`.as('userId'),
				kind: sql`'assigned'`.as('kind'),
				actorId: sql`${input.actorId}`.as('actorId'),
				targetKind: sql`'task'`.as('targetKind'),
				targetId: sql`${input.taskId}`.as('targetId'),
				commentId: sql`null`.as('commentId'),
				createdAt: sql`${input.now}`.as('createdAt'),
				readAt: sql`null`.as('readAt')
			})
			.from(tasks)
			.where(
				and(
					eq(tasks.id, input.taskId),
					eq(tasks.assigneeId, input.assigneeId),
					isNull(tasks.deletedAt),
					input.updatedAt === undefined ? undefined : eq(tasks.updatedAt, input.updatedAt),
					sql`${input.assigneeId} <> ${input.actorId}`,
					sql`exists (select 1 from users u where u.id = ${input.assigneeId} and u.status = 'active')`,
					sql`not exists (select 1 from notifications n where n.user_id = ${input.assigneeId} and n.kind = 'assigned' and n.target_kind = 'task' and n.target_id = ${input.taskId} and n.read_at is null)`
				)
			)
	);
}
