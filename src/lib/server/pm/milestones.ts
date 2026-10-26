import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { TASK_STATUSES, type MilestoneStatus, type TaskStatus } from '#lib/shared/enums';
import type { SessionUser } from '../auth/session';
import type { Db } from '../db';
import { batchAssert, isBatchAssertFailure } from '../db/assert';
import { milestones, tasks, users } from '../db/schema';
import { projectActive } from '../tasks/repo';
import { newId } from '../util';
import {
	holds,
	managerRefusal,
	mayManageProject,
	projectRefusal,
	type Manager,
	type PmWrite
} from './common';
import { PM_LIMITS, PM_MESSAGES, type MilestoneInput } from './validation';

/**
 * Milestones of a project (RB-08): a name, an optional due date, open or closed. Edits and status changes compare
 * `updated_at`; the 50-per-project cap is a count inside the INSERT; deleting soft-deletes the milestone and clears
 * the link on its tasks in the same batch (without touching their `updated_at`). Managing is for the project's
 * manager (checked by the route on a fresh read); assigning tasks goes through the task patch.
 */

type Actor = Pick<SessionUser, 'id'>;

export interface Milestone {
	id: string;
	name: string;
	description: string;
	dueOn: string | null;
	status: MilestoneStatus;
	closedAt: number | null;
	updatedAt: number;
}

const columns = {
	id: milestones.id,
	name: milestones.name,
	description: milestones.description,
	dueOn: milestones.dueOn,
	status: milestones.status,
	closedAt: milestones.closedAt,
	updatedAt: milestones.updatedAt
};

/** Live milestones: open first, then by due date (none last) and name. */
export async function listMilestones(db: Db, projectId: string): Promise<Milestone[]> {
	return db
		.select(columns)
		.from(milestones)
		.where(and(eq(milestones.projectId, projectId), isNull(milestones.deletedAt)))
		.orderBy(
			desc(sql`${milestones.status} = 'open'`),
			sql`${milestones.dueOn} is null`,
			asc(milestones.dueOn),
			asc(milestones.name)
		)
		.limit(PM_LIMITS.milestonesPerProject * 2);
}

/** A live milestone of the project, or null (another project's id and a deleted one look the same). */
export async function getMilestone(
	db: Db,
	projectId: string,
	id: string
): Promise<Milestone | null> {
	const row = await db
		.select(columns)
		.from(milestones)
		.where(
			and(eq(milestones.id, id), eq(milestones.projectId, projectId), isNull(milestones.deletedAt))
		)
		.get();
	return row ?? null;
}

export async function createMilestone(
	db: Db,
	actor: Actor,
	projectId: string,
	input: MilestoneInput,
	at: number
): Promise<PmWrite<{ id: string }>> {
	const id = newId();
	const rows = await db
		.insert(milestones)
		.select(
			db
				.select({
					id: sql`${id}`.as('id'),
					projectId: sql`${projectId}`.as('projectId'),
					name: sql`${input.name}`.as('name'),
					description: sql`${input.description}`.as('description'),
					dueOn: sql`${input.dueOn}`.as('dueOn'),
					status: sql`'open'`.as('status'),
					closedAt: sql`null`.as('closedAt'),
					createdBy: sql`${actor.id}`.as('createdBy'),
					createdAt: sql`${at}`.as('createdAt'),
					updatedAt: sql`${at}`.as('updatedAt'),
					deletedAt: sql`null`.as('deletedAt')
				})
				.from(sql`(select 1)`)
				.where(
					and(
						projectActive(projectId),
						sql`(select count(*) from milestones m where m.project_id = ${projectId} and m.deleted_at is null) < ${PM_LIMITS.milestonesPerProject}`
					)
				)
		)
		.returning({ id: milestones.id });
	if (rows.length === 1) return { ok: true, id };
	return (
		(await projectRefusal(db, projectId)) ?? {
			ok: false,
			reason: 'limit',
			message: PM_MESSAGES.milestoneLimit
		}
	);
}

async function refusal(db: Db, projectId: string, id: string, actor: Manager): Promise<PmWrite> {
	if (!(await getMilestone(db, projectId, id))) return { ok: false, reason: 'not_found' };
	return (
		(await projectRefusal(db, projectId)) ??
		(await managerRefusal(db, projectId, actor)) ?? {
			ok: false,
			reason: 'conflict',
			message: PM_MESSAGES.changed
		}
	);
}

const scope = (projectId: string, id: string, expected: number, actor: Manager) =>
	and(
		eq(milestones.id, id),
		eq(milestones.projectId, projectId),
		isNull(milestones.deletedAt),
		eq(milestones.updatedAt, expected),
		projectActive(projectId),
		mayManageProject(projectId, actor)
	);

export async function updateMilestone(
	db: Db,
	actor: Manager,
	projectId: string,
	id: string,
	input: MilestoneInput,
	expected: number,
	at: number
): Promise<PmWrite> {
	const rows = await db
		.update(milestones)
		.set({ ...input, updatedAt: Math.max(at, expected + 1) })
		.where(scope(projectId, id, expected, actor))
		.returning({ id: milestones.id });
	return rows.length === 1 ? { ok: true } : refusal(db, projectId, id, actor);
}

/** Closes (sets `closed_at`) or reopens (clears it). A closed milestone takes no new tasks. */
export async function setMilestoneStatus(
	db: Db,
	actor: Manager,
	projectId: string,
	id: string,
	status: MilestoneStatus,
	expected: number,
	at: number
): Promise<PmWrite> {
	const rows = await db
		.update(milestones)
		.set({
			status,
			closedAt: status === 'closed' ? at : null,
			updatedAt: Math.max(at, expected + 1)
		})
		.where(scope(projectId, id, expected, actor))
		.returning({ id: milestones.id });
	return rows.length === 1 ? { ok: true } : refusal(db, projectId, id, actor);
}

/**
 * Soft-deletes the milestone and unlinks its tasks in one batch, after an assertion that it is live in an active
 * project. Already deleted counts as done; another project's id is not found.
 */
export async function deleteMilestone(
	db: Db,
	actor: Manager,
	projectId: string,
	id: string,
	at: number
): Promise<PmWrite> {
	try {
		await db.batch([
			batchAssert(
				db,
				sql`exists (select 1 from milestones m where m.id = ${id} and m.project_id = ${projectId} and m.deleted_at is null) and ${projectActive(projectId)} and ${mayManageProject(projectId, actor)}`
			),
			db
				.update(tasks)
				.set({ milestoneId: null })
				.where(and(eq(tasks.milestoneId, id), eq(tasks.projectId, projectId))),
			db
				.update(milestones)
				.set({ deletedAt: at, updatedAt: at })
				.where(and(eq(milestones.id, id), eq(milestones.projectId, projectId)))
		]);
		return { ok: true };
	} catch (e) {
		if (!isBatchAssertFailure(e)) throw e;
	}
	const refused =
		(await projectRefusal(db, projectId)) ?? (await managerRefusal(db, projectId, actor));
	if (refused) return refused;
	const existed = await holds(
		db,
		sql`exists (select 1 from milestones m where m.id = ${id} and m.project_id = ${projectId})`
	);
	return existed ? { ok: true } : { ok: false, reason: 'not_found' };
}

export interface MilestoneProgress {
	/** Live tasks per status. */
	byStatus: Record<TaskStatus, number>;
	done: number;
	/** Live tasks that are not canceled. */
	total: number;
	/** 0-100, rounded down; 0 with no tasks. */
	percent: number;
}

/** Progress from per-status counts: done over the non-canceled total (pure). */
export function progressFrom(counts: ReadonlyMap<string, number>): MilestoneProgress {
	const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, counts.get(s) ?? 0])) as Record<
		TaskStatus,
		number
	>;
	const total = TASK_STATUSES.reduce((n, s) => n + (s === 'canceled' ? 0 : byStatus[s]), 0);
	const done = byStatus.done;
	return { byStatus, done, total, percent: total === 0 ? 0 : Math.floor((done * 100) / total) };
}

/** Counts per milestone of a project (live tasks), computed in SQL. */
export async function milestoneProgress(
	db: Db,
	projectId: string
): Promise<Map<string, MilestoneProgress>> {
	const rows = await db
		.select({ milestoneId: tasks.milestoneId, status: tasks.status, n: sql<number>`count(*)` })
		.from(tasks)
		.where(
			and(
				eq(tasks.projectId, projectId),
				isNull(tasks.deletedAt),
				sql`${tasks.milestoneId} is not null`
			)
		)
		.groupBy(tasks.milestoneId, tasks.status);
	const per = new Map<string, Map<string, number>>();
	for (const r of rows) {
		if (!r.milestoneId) continue;
		const m = per.get(r.milestoneId) ?? new Map<string, number>();
		m.set(r.status, Number(r.n));
		per.set(r.milestoneId, m);
	}
	return new Map([...per].map(([id, counts]) => [id, progressFrom(counts)]));
}

export interface MilestoneTask {
	id: string;
	number: number;
	title: string;
	status: TaskStatus;
	assigneeName: string | null;
}

/** The milestone's live tasks by status (board order) then position, bounded. */
export async function milestoneTasks(
	db: Db,
	projectId: string,
	id: string
): Promise<MilestoneTask[]> {
	// Compile-time constants only: the status enum's own values and their indexes.
	const order = sql`case ${tasks.status} ${sql.raw(TASK_STATUSES.map((s, i) => `when '${s}' then ${i}`).join(' '))} end`;
	return db
		.select({
			id: tasks.id,
			number: tasks.number,
			title: tasks.title,
			status: tasks.status,
			assigneeName: users.name
		})
		.from(tasks)
		.leftJoin(users, eq(users.id, tasks.assigneeId))
		.where(and(eq(tasks.projectId, projectId), eq(tasks.milestoneId, id), isNull(tasks.deletedAt)))
		.orderBy(order, asc(tasks.position), asc(tasks.number))
		.limit(PM_LIMITS.milestoneTasksMax);
}
