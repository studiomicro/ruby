import { and, asc, desc, eq, gt, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import {
	CLOSED_TASK_STATUSES,
	TASK_STATUSES,
	type ProjectStatus,
	type TaskPriority,
	type TaskStatus
} from '#lib/shared/enums';
import type { SessionUser } from '../auth/session';
import type { Db } from '../db';
import { milestones, projects, tasks, users } from '../db/schema';
import { isUniqueViolation, newId } from '../util';
import { activeUserOrNone, CLOSED_STATUS_LIST } from '../projects/repo';
import { taskDueChangedStatement } from '../reminders/repo';
import { assignedNotificationStatement } from './assign-notification';
import { dueBucket, type DueBucket } from './dates';
import { needsRenumber, POSITION_STEP, positionBetween } from './position';
import {
	LIMITS,
	MESSAGES,
	type Placement,
	type SortDir,
	type TaskField,
	type TaskFields,
	type TaskFilters,
	type TaskSort
} from './validation';

/**
 * Tasks. Every read filters `deleted_at IS NULL`; every write is one guarded statement or one `db.batch` (D1 has no
 * interactive transactions): the project must be active when the statement runs (owner decision 2), an edit applies
 * only to the version it was made from, and the `assigned` notification is part of the same batch as the write.
 * Ties in `position` are broken by `number` in every ordered read, so order is deterministic.
 */

type Actor = Pick<SessionUser, 'id' | 'role'>;
type ProjectScope = { id: string };

const assignee = alias(users, 'assignee');
const milestone = alias(milestones, 'milestone');
/** The task's milestone (RB-08), joined for its name; a deleted milestone never stays linked. */
const milestoneJoin = and(eq(milestone.id, tasks.milestoneId), isNull(milestone.deletedAt));
const creator = alias(users, 'creator');
const closedJson = JSON.stringify(CLOSED_STATUS_LIST);

/** `priority` as a rank for sorting: urgent highest. */
const priorityRank = sql<number>`case ${tasks.priority} when 'urgent' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end`;

const rowColumns = {
	id: tasks.id,
	number: tasks.number,
	title: tasks.title,
	status: tasks.status,
	priority: tasks.priority,
	assigneeId: tasks.assigneeId,
	assigneeName: assignee.name,
	dueOn: tasks.dueOn,
	position: tasks.position,
	updatedAt: tasks.updatedAt,
	completedAt: tasks.completedAt,
	milestoneId: tasks.milestoneId,
	milestoneName: milestone.name
};

export interface TaskRow {
	id: string;
	number: number;
	title: string;
	status: TaskStatus;
	priority: TaskPriority;
	assigneeId: string | null;
	assigneeName: string | null;
	dueOn: string | null;
	position: number;
	updatedAt: number;
	completedAt: number | null;
	milestoneId: string | null;
	milestoneName: string | null;
}

export interface TaskDetail extends TaskRow {
	projectId: string;
	description: string;
	assigneeActive: boolean;
	createdBy: string;
	createdByName: string | null;
	createdAt: number;
}

/** SQL: the task's project is active and live (owner decision 2: archived projects are read-only for tasks). */
export const projectActive = (projectId: string) =>
	sql`exists (select 1 from projects p where p.id = ${projectId} and p.status = 'active' and p.deleted_at is null)`;

/** SQL: `milestoneId` names an open, live milestone of the project (RB-08: the only kind a task can newly take). */
export const milestoneAssignable = (projectId: string, milestoneId: string) =>
	sql`exists (select 1 from milestones m where m.id = ${milestoneId} and m.project_id = ${projectId} and m.status = 'open' and m.deleted_at is null)`;

/** SQL: the next bottom position of a status column. */
const bottomOf = (projectId: string, status: TaskStatus) =>
	sql`(select coalesce(max(t.position), 0) + ${POSITION_STEP} from tasks t where t.project_id = ${projectId} and t.status = ${status} and t.deleted_at is null)`;

/**
 * SQL for `completed_at` when the status becomes `next`: set to `at` on entering a closed status from an open one,
 * kept when moving between closed statuses, cleared on reopening. It reads the stored status (the old value inside
 * an UPDATE's SET), so a racing writer cannot leave it wrong.
 */
export const completedAtFor = (next: TaskStatus, at: number) =>
	CLOSED_TASK_STATUSES.has(next)
		? sql`case when ${tasks.status} in (select value from json_each(${closedJson})) then ${tasks.completedAt} else ${at} end`
		: sql`null`;

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────────────────

function filterConditions(
	projectId: string,
	filters: TaskFilters,
	viewerId: string,
	withStatuses: boolean
): SQL[] {
	const conditions: SQL[] = [eq(tasks.projectId, projectId), isNull(tasks.deletedAt)];
	if (withStatuses && filters.statuses.length > 0)
		conditions.push(
			sql`${tasks.status} in (select value from json_each(${JSON.stringify(filters.statuses)}))`
		);
	if (filters.priorities.length > 0)
		conditions.push(
			sql`${tasks.priority} in (select value from json_each(${JSON.stringify(filters.priorities)}))`
		);
	const a = filters.assignee;
	if (a === 'me') conditions.push(eq(tasks.assigneeId, viewerId));
	else if (a === 'none') conditions.push(isNull(tasks.assigneeId));
	else if (a !== 'any') conditions.push(eq(tasks.assigneeId, a.userId));
	// RB-08: any of the labels (live ones only), and the milestone (`none`: no milestone).
	if (filters.labels.length > 0)
		conditions.push(
			sql`exists (select 1 from task_labels tl join labels l on l.id = tl.label_id where tl.task_id = ${tasks.id} and l.deleted_at is null and tl.label_id in (select value from json_each(${JSON.stringify(filters.labels)})))`
		);
	const m = filters.milestone;
	if (m === 'none') conditions.push(isNull(tasks.milestoneId));
	else if (m !== 'any') conditions.push(eq(tasks.milestoneId, m.id));
	return conditions;
}

function sortOrder(sort: TaskSort, dir: SortDir): SQL[] {
	const by = dir === 'asc' ? asc : desc;
	switch (sort) {
		case 'priority':
			return [by(priorityRank), desc(tasks.number)];
		case 'due':
			// No due date sorts last either way.
			return [sql`${tasks.dueOn} is null`, by(tasks.dueOn), desc(tasks.number)];
		case 'updated':
			return [by(tasks.updatedAt), desc(tasks.number)];
		default:
			return [by(tasks.number)];
	}
}

/** One page (LIMITS.pageSize) of a project's tasks matching `filters`, and how many match in all. */
export async function listTasks(
	db: Db,
	projectId: string,
	filters: TaskFilters,
	sort: { sort: TaskSort; dir: SortDir },
	page: number,
	viewerId: string
): Promise<{ rows: TaskRow[]; total: number }> {
	const where = and(...filterConditions(projectId, filters, viewerId, true));
	const [rows, count] = await db.batch([
		db
			.select(rowColumns)
			.from(tasks)
			.leftJoin(assignee, eq(assignee.id, tasks.assigneeId))
			.leftJoin(milestone, milestoneJoin)
			.where(where)
			.orderBy(...sortOrder(sort.sort, sort.dir))
			.limit(LIMITS.pageSize)
			.offset((page - 1) * LIMITS.pageSize),
		db
			.select({ n: sql<number>`count(*)` })
			.from(tasks)
			.where(where)
	]);
	return { rows, total: Number(count[0]?.n ?? 0) };
}

export interface BoardColumn {
	status: TaskStatus;
	/** Every task of this column that matches the filters (may exceed `tasks.length`). */
	count: number;
	/** At most LIMITS.boardColumnMax, by position then number. */
	tasks: TaskRow[];
}

/**
 * The board: one column per status in TASK_STATUSES order (a status filter hides columns), each with up to
 * LIMITS.boardColumnMax cards and its full count from one grouped count query. One round trip.
 */
export async function boardTasks(
	db: Db,
	projectId: string,
	filters: TaskFilters,
	viewerId: string
): Promise<BoardColumn[]> {
	const statuses = filters.statuses.length > 0 ? filters.statuses : [...TASK_STATUSES];
	const base = filterConditions(projectId, filters, viewerId, false);
	const columnQuery = (status: TaskStatus) =>
		db
			.select(rowColumns)
			.from(tasks)
			.leftJoin(assignee, eq(assignee.id, tasks.assigneeId))
			.leftJoin(milestone, milestoneJoin)
			.where(and(...base, eq(tasks.status, status)))
			.orderBy(asc(tasks.position), asc(tasks.number))
			.limit(LIMITS.boardColumnMax);
	const countQuery = db
		.select({ status: tasks.status, n: sql<number>`count(*)` })
		.from(tasks)
		.where(and(...base))
		.groupBy(tasks.status);
	const [counts, ...columns] = await db.batch([
		countQuery,
		...(statuses.map(columnQuery) as [ReturnType<typeof columnQuery>])
	]);
	const countOf = new Map(counts.map((c) => [c.status, Number(c.n)]));
	return statuses.map((status, i) => ({
		status,
		count: countOf.get(status) ?? 0,
		tasks: (columns[i] ?? []) as TaskRow[]
	}));
}

const detailColumns = {
	...rowColumns,
	projectId: tasks.projectId,
	description: tasks.description,
	assigneeActive: sql<number>`coalesce(${assignee.status} = 'active', 0)`,
	createdBy: tasks.createdBy,
	createdByName: creator.name,
	createdAt: tasks.createdAt
};

function detailQuery(db: Db, where: SQL | undefined) {
	return db
		.select(detailColumns)
		.from(tasks)
		.leftJoin(assignee, eq(assignee.id, tasks.assigneeId))
		.leftJoin(milestone, milestoneJoin)
		.leftJoin(creator, eq(creator.id, tasks.createdBy))
		.where(where);
}
const toDetail = (row: Omit<TaskDetail, 'assigneeActive'> & { assigneeActive: number }) => ({
	...row,
	assigneeActive: Boolean(row.assigneeActive)
});

/** A live task of the project by number, or null (deleted and missing look the same). */
export async function getTaskByNumber(
	db: Db,
	projectId: string,
	number: number
): Promise<TaskDetail | null> {
	const row = await detailQuery(
		db,
		and(eq(tasks.projectId, projectId), eq(tasks.number, number), isNull(tasks.deletedAt))
	).get();
	return row ? toDetail(row) : null;
}

/** A live task of the project by id, or null: a task id is never trusted without its project. */
export async function getTaskById(
	db: Db,
	projectId: string,
	id: string
): Promise<TaskDetail | null> {
	const row = await detailQuery(
		db,
		and(eq(tasks.projectId, projectId), eq(tasks.id, id), isNull(tasks.deletedAt))
	).get();
	return row ? toDetail(row) : null;
}

export interface MyTaskRow extends TaskRow {
	projectKey: string;
	projectStatus: ProjectStatus;
}

/** My tasks: open tasks assigned to `userId` grouped by due date, plus (with `closed`) the latest closed ones. */
export async function listMyTasks(
	db: Db,
	userId: string,
	options: { closed: boolean },
	today: string
): Promise<{ groups: Record<DueBucket, MyTaskRow[]>; closed: MyTaskRow[] }> {
	const columns = { ...rowColumns, projectKey: projects.key, projectStatus: projects.status };
	const base = [eq(tasks.assigneeId, userId), isNull(tasks.deletedAt), isNull(projects.deletedAt)];
	const open = db
		.select(columns)
		.from(tasks)
		.innerJoin(projects, eq(projects.id, tasks.projectId))
		.leftJoin(assignee, eq(assignee.id, tasks.assigneeId))
		.leftJoin(milestone, milestoneJoin)
		.where(and(...base, sql`${tasks.status} not in (select value from json_each(${closedJson}))`))
		.orderBy(desc(priorityRank), sql`${tasks.dueOn} is null`, asc(tasks.dueOn), asc(tasks.number))
		.limit(LIMITS.myTasksMax);
	const closed = db
		.select(columns)
		.from(tasks)
		.innerJoin(projects, eq(projects.id, tasks.projectId))
		.leftJoin(assignee, eq(assignee.id, tasks.assigneeId))
		.leftJoin(milestone, milestoneJoin)
		.where(and(...base, sql`${tasks.status} in (select value from json_each(${closedJson}))`))
		.orderBy(desc(tasks.completedAt), desc(tasks.number))
		.limit(LIMITS.myTasksClosedMax);
	const [openRows, closedRows] = options.closed
		? await db.batch([open, closed])
		: [await open, [] as MyTaskRow[]];
	const groups: Record<DueBucket, MyTaskRow[]> = { overdue: [], today: [], upcoming: [], none: [] };
	for (const row of openRows) groups[dueBucket(row.dueOn, today)].push(row);
	return { groups, closed: closedRows };
}

// ── Writes ──────────────────────────────────────────────────────────────────────────────────────────────────

export type TaskWrite<T = object> =
	| ({ ok: true } & T)
	| { ok: false; reason: 'not_found' | 'archived' | 'busy' }
	| { ok: false; reason: 'invalid'; errors: Partial<Record<TaskField | 'form', string>> }
	| { ok: false; reason: 'conflict'; current: TaskDetail };

async function projectState(db: Db, projectId: string) {
	return db
		.select({ status: projects.status, deletedAt: projects.deletedAt })
		.from(projects)
		.where(eq(projects.id, projectId))
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

async function isAssignableMilestone(db: Db, projectId: string, id: string): Promise<boolean> {
	const row = await db
		.select({ ok: sql<number>`1` })
		.from(sql`(select 1)`)
		.where(milestoneAssignable(projectId, id))
		.get();
	return !!row;
}

/** Why a guarded project-scoped write wrote nothing: the project is gone or archived, or null (neither). */
async function projectRefusal(
	db: Db,
	projectId: string
): Promise<{ ok: false; reason: 'not_found' | 'archived' } | null> {
	const project = await projectState(db, projectId);
	if (!project || project.deletedAt !== null) return { ok: false, reason: 'not_found' };
	if (project.status !== 'active') return { ok: false, reason: 'archived' };
	return null;
}

/**
 * Creates a task in one batch: the INSERT takes `number` from `projects.next_task_number` (and is guarded by the
 * project being active and the assignee being active), the counter is bumped only when that row exists, and the
 * `assigned` notification follows. D1 runs a batch as one serialised transaction, so concurrent creates get
 * consecutive numbers with no read-then-write gap; a UNIQUE collision on (project, number) rolls the whole batch
 * back and is retried up to LIMITS.createAttempts times.
 */
export async function createTask(
	db: Db,
	actor: Actor,
	project: ProjectScope,
	input: TaskFields,
	at: number
): Promise<TaskWrite<{ id: string; number: number }>> {
	for (let attempt = 0; attempt < LIMITS.createAttempts; attempt++) {
		const id = newId();
		const notify =
			input.assigneeId !== null && input.assigneeId !== actor.id
				? [
						assignedNotificationStatement(db, {
							taskId: id,
							assigneeId: input.assigneeId,
							actorId: actor.id,
							now: at
						})
					]
				: [];
		try {
			const [inserted] = await db.batch([
				db
					.insert(tasks)
					.select(
						db
							.select({
								id: sql`${id}`.as('id'),
								projectId: projects.id,
								number: projects.nextTaskNumber,
								title: sql`${input.title}`.as('title'),
								description: sql`${input.description}`.as('description'),
								status: sql`${input.status}`.as('status'),
								priority: sql`${input.priority}`.as('priority'),
								assigneeId: sql`${input.assigneeId}`.as('assigneeId'),
								dueOn: sql`${input.dueOn}`.as('dueOn'),
								position: bottomOf(project.id, input.status).as('position'),
								createdBy: sql`${actor.id}`.as('createdBy'),
								createdAt: sql`${at}`.as('createdAt'),
								updatedAt: sql`${at}`.as('updatedAt'),
								completedAt: (CLOSED_TASK_STATUSES.has(input.status) ? sql`${at}` : sql`null`).as(
									'completedAt'
								),
								deletedAt: sql`null`.as('deletedAt'),
								milestoneId: sql`${input.milestoneId}`.as('milestoneId')
							})
							.from(projects)
							.where(
								and(
									eq(projects.id, project.id),
									eq(projects.status, 'active'),
									isNull(projects.deletedAt),
									activeUserOrNone(input.assigneeId),
									input.milestoneId === null
										? undefined
										: milestoneAssignable(project.id, input.milestoneId)
								)
							)
					)
					.returning({ number: tasks.number }),
				db
					.update(projects)
					.set({ nextTaskNumber: sql`${projects.nextTaskNumber} + 1`, updatedAt: at })
					.where(
						and(eq(projects.id, project.id), sql`exists (select 1 from tasks t where t.id = ${id})`)
					),
				...notify
			]);
			const row = inserted[0];
			if (row) return { ok: true, id, number: row.number };
			const refused = await projectRefusal(db, project.id);
			if (refused) return refused;
			if (
				input.milestoneId !== null &&
				!(await isAssignableMilestone(db, project.id, input.milestoneId))
			)
				return { ok: false, reason: 'invalid', errors: { milestoneId: MESSAGES.milestone } };
			return { ok: false, reason: 'invalid', errors: { assigneeId: MESSAGES.assignee } };
		} catch (e) {
			if (!isUniqueViolation(e)) throw e;
		}
	}
	return { ok: false, reason: 'busy' };
}

/**
 * Writes `fields` (a full edit or one patched field) against version `expected`. Guarded: live task, active
 * project, `updated_at = expected`, and a changed assignee must be active (an unchanged, now-disabled one is
 * kept). A status change puts the card at the bottom of its new column and applies the `completed_at` rule. A new
 * assignee other than the actor gets an `assigned` notification in the same batch, inserted only if this write
 * stored the version it names. Nothing written: not found, archived, conflict (with the current task) or invalid.
 */
export async function updateTask(
	db: Db,
	actor: Actor,
	project: ProjectScope,
	task: Pick<TaskDetail, 'id' | 'assigneeId'>,
	fields: Partial<TaskFields>,
	expected: number,
	at: number
): Promise<TaskWrite> {
	const updatedAt = Math.max(at, expected + 1);
	const set: Record<string, unknown> = { ...fields, updatedAt };
	if (fields.status !== undefined) {
		set.position = sql`case when ${tasks.status} = ${fields.status} then ${tasks.position} else ${bottomOf(project.id, fields.status)} end`;
		set.completedAt = completedAtFor(fields.status, at);
	}
	const newAssignee = fields.assigneeId;
	const newMilestone = fields.milestoneId;
	const update = db
		.update(tasks)
		.set(set)
		.where(
			and(
				eq(tasks.id, task.id),
				eq(tasks.projectId, project.id),
				isNull(tasks.deletedAt),
				eq(tasks.updatedAt, expected),
				projectActive(project.id),
				newAssignee
					? sql`(${newAssignee} = ${tasks.assigneeId} or exists (select 1 from users u where u.id = ${newAssignee} and u.status = 'active'))`
					: undefined,
				// RB-08: a kept milestone may be closed; a new one must be open, live and of this project.
				newMilestone
					? sql`(${newMilestone} = ${tasks.milestoneId} or ${milestoneAssignable(project.id, newMilestone)})`
					: undefined
			)
		)
		.returning({ id: tasks.id });
	const notify =
		newAssignee && newAssignee !== task.assigneeId && newAssignee !== actor.id
			? [
					assignedNotificationStatement(db, {
						taskId: task.id,
						assigneeId: newAssignee,
						actorId: actor.id,
						now: at,
						updatedAt
					})
				]
			: [];
	// RB-09: a changed due date re-derives the task's relative reminders (reminders/repo.ts).
	const reminders =
		fields.dueOn !== undefined ? [taskDueChangedStatement(db, task.id, updatedAt, at)] : [];
	const [written] = await db.batch([update, ...notify, ...reminders]);
	if (written.length === 1) return { ok: true };

	const current = await getTaskById(db, project.id, task.id);
	if (!current) return { ok: false, reason: 'not_found' };
	const refused = await projectRefusal(db, project.id);
	if (refused) return refused;
	if (current.updatedAt !== expected) return { ok: false, reason: 'conflict', current };
	if (newAssignee && !(await isActiveUser(db, newAssignee)))
		return { ok: false, reason: 'invalid', errors: { assigneeId: MESSAGES.assignee } };
	if (
		newMilestone &&
		newMilestone !== current.milestoneId &&
		!(await isAssignableMilestone(db, project.id, newMilestone))
	)
		return { ok: false, reason: 'invalid', errors: { milestoneId: MESSAGES.milestone } };
	return { ok: false, reason: 'conflict', current };
}

/** One field of a task (the detail page's sidebar forms), with the same guards as a full edit. */
export function patchTask<F extends TaskField>(
	db: Db,
	actor: Actor,
	project: ProjectScope,
	task: Pick<TaskDetail, 'id' | 'assigneeId'>,
	field: F,
	value: TaskFields[F],
	expected: number,
	at: number
): Promise<TaskWrite> {
	return updateTask(db, actor, project, task, { [field]: value }, expected, at);
}

type Neighbour = { position: number; number: number };

async function columnEnd(
	db: Db,
	projectId: string,
	status: TaskStatus,
	exclude: string,
	end: 'first' | 'last'
): Promise<number | null> {
	const by = end === 'first' ? asc : desc;
	const row = await db
		.select({ position: tasks.position })
		.from(tasks)
		.where(
			and(
				eq(tasks.projectId, projectId),
				eq(tasks.status, status),
				isNull(tasks.deletedAt),
				ne(tasks.id, exclude)
			)
		)
		.orderBy(by(tasks.position), by(tasks.number))
		.limit(1)
		.get();
	return row?.position ?? null;
}

async function nextAfter(
	db: Db,
	projectId: string,
	status: TaskStatus,
	exclude: string,
	prev: Neighbour
): Promise<number | null> {
	const row = await db
		.select({ position: tasks.position })
		.from(tasks)
		.where(
			and(
				eq(tasks.projectId, projectId),
				eq(tasks.status, status),
				isNull(tasks.deletedAt),
				ne(tasks.id, exclude),
				or(
					gt(tasks.position, prev.position),
					and(eq(tasks.position, prev.position), gt(tasks.number, prev.number))
				)
			)
		)
		.orderBy(asc(tasks.position), asc(tasks.number))
		.limit(1)
		.get();
	return row?.position ?? null;
}

/** The task `afterId` names when it is a live task of the same project in the target column (not the moved one). */
async function anchor(
	db: Db,
	projectId: string,
	status: TaskStatus,
	taskId: string,
	afterId: string
): Promise<Neighbour | null> {
	if (afterId === taskId) return null;
	const row = await db
		.select({ position: tasks.position, number: tasks.number })
		.from(tasks)
		.where(
			and(
				eq(tasks.id, afterId),
				eq(tasks.projectId, projectId),
				eq(tasks.status, status),
				isNull(tasks.deletedAt)
			)
		)
		.get();
	return row ?? null;
}

/**
 * Spreads a column's positions to POSITION_STEP · rank in one statement, keeping the order (position, number).
 * Only positions change; `updated_at` stays, so a renumber never makes an open edit form stale.
 */
export async function renumberColumn(db: Db, projectId: string, status: TaskStatus): Promise<void> {
	// Guarded like every task write: an archived or deleted project's positions stay frozen (red team L4).
	await db.run(sql`update tasks set position = r.rn * ${POSITION_STEP}
		from (select id, row_number() over (order by position, number) as rn from tasks
			where project_id = ${projectId} and status = ${status} and deleted_at is null) as r
		where tasks.id = r.id and ${projectActive(projectId)}`);
}

/** The position a moved card takes; renumbers the column first when the gap is too small. */
async function targetPosition(
	db: Db,
	projectId: string,
	taskId: string,
	status: TaskStatus,
	placement: Placement
): Promise<number> {
	let prev: Neighbour | null = null;
	let where: 'top' | 'bottom' | 'after';
	if ('after' in placement) {
		if (placement.after === null) where = 'top';
		else {
			prev = await anchor(db, projectId, status, taskId, placement.after);
			// An anchor in another column or project, deleted or unknown, is ignored: the card goes to the bottom.
			where = prev ? 'after' : 'bottom';
		}
	} else where = placement.place;

	if (where === 'top')
		return positionBetween(null, await columnEnd(db, projectId, status, taskId, 'first'));
	if (where === 'bottom')
		return positionBetween(await columnEnd(db, projectId, status, taskId, 'last'), null);

	let anchorRow = prev as Neighbour;
	let next = await nextAfter(db, projectId, status, taskId, anchorRow);
	if (needsRenumber(anchorRow.position, next)) {
		await renumberColumn(db, projectId, status);
		anchorRow =
			(await anchor(db, projectId, status, taskId, (placement as { after: string }).after)) ??
			anchorRow;
		next = await nextAfter(db, projectId, status, taskId, anchorRow);
	}
	return positionBetween(anchorRow.position, next);
}

/**
 * Moves a card to `status` at `placement`. Last move wins (no version check: the neighbours are advisory). The
 * project must be active when the UPDATE runs; `completed_at` follows the status rule.
 */
export async function moveTask(
	db: Db,
	project: ProjectScope,
	taskId: string,
	status: TaskStatus,
	placement: Placement,
	at: number
): Promise<TaskWrite<{ position: number }>> {
	const task = await getTaskById(db, project.id, taskId);
	if (!task) return { ok: false, reason: 'not_found' };
	const refused = await projectRefusal(db, project.id);
	if (refused) return refused;
	const position = await targetPosition(db, project.id, taskId, status, placement);
	const rows = await db
		.update(tasks)
		.set({
			status,
			position,
			completedAt: completedAtFor(status, at),
			updatedAt: sql`max(${at}, ${tasks.updatedAt} + 1)`
		})
		.where(
			and(
				eq(tasks.id, taskId),
				eq(tasks.projectId, project.id),
				isNull(tasks.deletedAt),
				projectActive(project.id)
			)
		)
		.returning({ id: tasks.id });
	if (rows.length === 1) return { ok: true, position };
	return (await projectRefusal(db, project.id)) ?? { ok: false, reason: 'not_found' };
}

/**
 * Soft-deletes a task (its number is never reused: the counter only grows). Already deleted counts as done
 * (idempotent); an archived project refuses. The caller checks canDeleteTask on a fresh read first.
 */
export async function deleteTask(
	db: Db,
	project: ProjectScope,
	taskId: string,
	at: number
): Promise<TaskWrite> {
	await db
		.update(tasks)
		.set({ deletedAt: at, updatedAt: sql`max(${at}, ${tasks.updatedAt} + 1)` })
		.where(
			and(
				eq(tasks.id, taskId),
				eq(tasks.projectId, project.id),
				isNull(tasks.deletedAt),
				projectActive(project.id)
			)
		);
	const live = await getTaskById(db, project.id, taskId);
	if (!live) return { ok: true };
	return (await projectRefusal(db, project.id)) ?? { ok: false, reason: 'busy' };
}
