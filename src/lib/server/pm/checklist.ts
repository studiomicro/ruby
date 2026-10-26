import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { SessionUser } from '../auth/session';
import type { Db } from '../db';
import { taskChecklistItems as items } from '../db/schema';
import { needsRenumber, POSITION_STEP, positionBetween } from '../tasks/position';
import { projectActive } from '../tasks/repo';
import { newId } from '../util';
import { holds, liveTask, projectRefusal, type PmRefusal, type PmWrite } from './common';
import { PM_LIMITS, PM_MESSAGES } from './validation';

/**
 * Checklist steps inside a task (RB-08). Every write is one guarded statement: the task is live in the project
 * named by the URL and the project is active when it runs. Adding counts the live steps inside the INSERT (the cap
 * holds under concurrent adds); ticking is idempotent and last-writer-wins; editing text compares `updated_at`.
 * No write touches `tasks.updated_at`, so an open task edit form never goes stale because of a step.
 */

type Actor = Pick<SessionUser, 'id'>;

export interface ChecklistItem {
	id: string;
	text: string;
	done: boolean;
	position: number;
	updatedAt: number;
}

/** A task's live steps in order. */
export async function listItems(db: Db, taskId: string): Promise<ChecklistItem[]> {
	const rows = await db
		.select({
			id: items.id,
			text: items.text,
			done: items.done,
			position: items.position,
			updatedAt: items.updatedAt
		})
		.from(items)
		.where(and(eq(items.taskId, taskId), isNull(items.deletedAt)))
		.orderBy(asc(items.position), asc(items.createdAt))
		.limit(PM_LIMITS.checklistPerTask * 2);
	return rows.map((r) => ({ ...r, done: r.done === 1 }));
}

const liveCount = (taskId: string) =>
	sql`(select count(*) from task_checklist_items c where c.task_id = ${taskId} and c.deleted_at is null)`;

/** SQL: the step is live and belongs to the task, whose project is active. */
const itemScope = (projectId: string, taskId: string, itemId: string) =>
	and(
		eq(items.id, itemId),
		eq(items.taskId, taskId),
		isNull(items.deletedAt),
		liveTask(projectId, taskId),
		projectActive(projectId)
	);

/** Why a step write found nothing: the task, the project, or the step itself is gone. */
async function refusal(db: Db, projectId: string, taskId: string): Promise<PmRefusal> {
	if (!(await holds(db, liveTask(projectId, taskId)))) return { ok: false, reason: 'not_found' };
	return (
		(await projectRefusal(db, projectId)) ?? {
			ok: false,
			reason: 'not_found',
			message: PM_MESSAGES.checkGone
		}
	);
}

export async function addItem(
	db: Db,
	actor: Actor,
	projectId: string,
	taskId: string,
	text: string,
	at: number
): Promise<PmWrite<{ id: string }>> {
	const id = newId();
	const rows = await db
		.insert(items)
		.select(
			db
				.select({
					id: sql`${id}`.as('id'),
					taskId: sql`${taskId}`.as('taskId'),
					text: sql`${text}`.as('text'),
					done: sql`0`.as('done'),
					position:
						sql`(select coalesce(max(c.position), 0) + ${POSITION_STEP} from task_checklist_items c where c.task_id = ${taskId} and c.deleted_at is null)`.as(
							'position'
						),
					doneBy: sql`null`.as('doneBy'),
					createdBy: sql`${actor.id}`.as('createdBy'),
					createdAt: sql`${at}`.as('createdAt'),
					updatedAt: sql`${at}`.as('updatedAt'),
					deletedAt: sql`null`.as('deletedAt')
				})
				.from(sql`(select 1)`)
				.where(
					and(
						liveTask(projectId, taskId),
						projectActive(projectId),
						sql`${liveCount(taskId)} < ${PM_LIMITS.checklistPerTask}`
					)
				)
		)
		.returning({ id: items.id });
	if (rows.length === 1) return { ok: true, id };
	if (!(await holds(db, liveTask(projectId, taskId)))) return { ok: false, reason: 'not_found' };
	return (
		(await projectRefusal(db, projectId)) ?? {
			ok: false,
			reason: 'limit',
			message: PM_MESSAGES.checkLimit
		}
	);
}

/** Ticks or unticks a step (idempotent; no version check: last writer wins on a boolean). */
export async function toggleItem(
	db: Db,
	actor: Actor,
	projectId: string,
	taskId: string,
	itemId: string,
	done: boolean,
	at: number
): Promise<PmWrite> {
	const rows = await db
		.update(items)
		.set({ done: done ? 1 : 0, doneBy: done ? actor.id : null, updatedAt: at })
		.where(itemScope(projectId, taskId, itemId))
		.returning({ id: items.id });
	return rows.length === 1 ? { ok: true } : refusal(db, projectId, taskId);
}

/** Changes a step's text against the version the form showed (409 "changed meanwhile" otherwise). */
export async function editItem(
	db: Db,
	projectId: string,
	taskId: string,
	itemId: string,
	text: string,
	expected: number,
	at: number
): Promise<PmWrite> {
	const rows = await db
		.update(items)
		.set({ text, updatedAt: Math.max(at, expected + 1) })
		.where(and(itemScope(projectId, taskId, itemId), eq(items.updatedAt, expected)))
		.returning({ id: items.id });
	if (rows.length === 1) return { ok: true };
	const live = await holds(
		db,
		sql`exists (select 1 from task_checklist_items c where c.id = ${itemId} and c.task_id = ${taskId} and c.deleted_at is null)`
	);
	if (!live) return refusal(db, projectId, taskId);
	return (
		(await projectRefusal(db, projectId)) ??
		((await holds(db, liveTask(projectId, taskId)))
			? { ok: false, reason: 'conflict', message: PM_MESSAGES.changed }
			: { ok: false, reason: 'not_found' })
	);
}

/** Soft-deletes a step; one already deleted counts as done. */
export async function deleteItem(
	db: Db,
	projectId: string,
	taskId: string,
	itemId: string,
	at: number
): Promise<PmWrite> {
	const rows = await db
		.update(items)
		.set({ deletedAt: at, updatedAt: at })
		.where(itemScope(projectId, taskId, itemId))
		.returning({ id: items.id });
	if (rows.length === 1) return { ok: true };
	const refused = await refusal(db, projectId, taskId);
	if (refused.message !== PM_MESSAGES.checkGone) return refused;
	const existed = await holds(
		db,
		sql`exists (select 1 from task_checklist_items c where c.id = ${itemId} and c.task_id = ${taskId})`
	);
	return existed ? { ok: true } : refused;
}

/** Spreads a task's step positions to POSITION_STEP · rank (order kept), when a midpoint has no room left. */
async function renumber(db: Db, projectId: string, taskId: string): Promise<void> {
	await db.run(sql`update task_checklist_items set position = r.rn * ${POSITION_STEP}
		from (select id, row_number() over (order by position, created_at) as rn from task_checklist_items
			where task_id = ${taskId} and deleted_at is null) as r
		where task_checklist_items.id = r.id and ${projectActive(projectId)}`);
}

/**
 * Moves a step one place up or down: it takes the midpoint between the two steps it lands between (like a board
 * card). Already first (up) or last (down) is a no-op. Last move wins.
 */
export async function moveItem(
	db: Db,
	projectId: string,
	taskId: string,
	itemId: string,
	direction: 'up' | 'down',
	at: number
): Promise<PmWrite> {
	const place = async () => {
		const list = await listItems(db, taskId);
		const i = list.findIndex((x) => x.id === itemId);
		if (i < 0) return null;
		const [prev, next] =
			direction === 'up'
				? [list[i - 2]?.position ?? null, list[i - 1]?.position ?? null]
				: [list[i + 1]?.position ?? null, list[i + 2]?.position ?? null];
		const noop = direction === 'up' ? i === 0 : i === list.length - 1;
		return { prev, next, noop };
	};
	let slot = await place();
	if (!slot) return refusal(db, projectId, taskId);
	const refused = await projectRefusal(db, projectId);
	if (refused) return refused;
	if (slot.noop) return { ok: true };
	if (needsRenumber(slot.prev, slot.next)) {
		await renumber(db, projectId, taskId);
		slot = await place();
		if (!slot) return refusal(db, projectId, taskId);
	}
	const rows = await db
		.update(items)
		.set({ position: positionBetween(slot.prev, slot.next), updatedAt: at })
		.where(itemScope(projectId, taskId, itemId))
		.returning({ id: items.id });
	return rows.length === 1 ? { ok: true } : refusal(db, projectId, taskId);
}

/**
 * Done and total live steps per task, for the given task ids (bound once as JSON), scoped to one project unless
 * `projectId` is null (My tasks spans projects). A batch item.
 */
export function progressQuery(db: Db, projectId: string | null, taskIds: readonly string[]) {
	return db
		.select({
			taskId: items.taskId,
			done: sql<number>`sum(${items.done})`,
			total: sql<number>`count(*)`
		})
		.from(items)
		.innerJoin(sql`tasks t`, sql`t.id = ${items.taskId}`)
		.where(
			and(
				sql`${items.taskId} in (select value from json_each(${JSON.stringify(taskIds)}))`,
				projectId === null ? undefined : sql`t.project_id = ${projectId}`,
				isNull(items.deletedAt)
			)
		)
		.groupBy(items.taskId);
}
