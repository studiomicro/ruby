import { and, asc, desc, eq, isNull, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type {
	LabelColor,
	MilestoneStatus,
	ProjectStatus,
	TaskPriority,
	TaskStatus,
	TaskType
} from '#lib/shared/enums';
import type { Db } from '../db';
import { labels, milestones, projects, tasks, users } from '../db/schema';
import { zoneDayStart } from '../hr/audit';
import type { TaskLabel } from '../pm/labels';
import { labelsForTasksQuery } from '../pm/labels';
import { listTeamLabelsQuery, teamLabelsForTasksQuery } from '../pm/team-labels';
import { listViewsQuery } from '../pm/views';
import { priorityRank, withAnyLabel } from '../tasks/repo';
import { LIMITS } from '../tasks/validation';
import { ISSUE_LIMITS, nextDay, type IssueFilters, type IssueSort } from './filters';
import type { SortDir } from '../tasks/validation';

/**
 * The cross-project Issues list (RB-12): every live task of every live project (archived projects only on request),
 * filtered, sorted with a stable `id` tie-break, 50 a page, and a total counted up to ISSUE_LIMITS.countCap. Two
 * round trips whatever the number of rows: the filter options (which also clean the filters of ids and keys that
 * no longer exist), then the page with its count and the labels of its rows. Every id list is bound once as JSON.
 */

const assignee = alias(users, 'assignee');

export interface IssueRow {
	id: string;
	number: number;
	title: string;
	type: TaskType;
	status: TaskStatus;
	priority: TaskPriority;
	assigneeId: string | null;
	assigneeName: string | null;
	dueOn: string | null;
	createdAt: number;
	updatedAt: number;
	projectKey: string;
	projectArchived: boolean;
	labels: TaskLabel[];
}

export interface IssueOptions {
	projects: { id: string; key: string; name: string; status: ProjectStatus }[];
	users: { id: string; name: string }[];
	teamLabels: { id: string; name: string; color: LabelColor }[];
	/** Project labels (of the chosen projects, or of all), with their project key; at most 300. */
	projectLabels: { id: string; name: string; color: LabelColor; projectKey: string }[];
	/** True when more project labels exist than were read ("Narrow by project to see more"). */
	moreProjectLabels: boolean;
	views: { id: string; name: string; query: string }[];
	/** The milestones of the one chosen project (none otherwise). */
	milestones: { id: string; name: string; status: MilestoneStatus }[];
}

/**
 * Everything the filters offer, in one round trip: projects (live; archived marked), active users, team labels,
 * project labels, the viewer's Issues views and, when exactly one project is chosen, its milestones.
 */
export async function issueFilterOptions(
	db: Db,
	viewerId: string,
	filters: Pick<IssueFilters, 'projects'>
): Promise<IssueOptions> {
	const keys = JSON.stringify(filters.projects);
	const one = filters.projects.length === 1 ? filters.projects[0]! : null;
	const queries = [
		db
			.select({ id: projects.id, key: projects.key, name: projects.name, status: projects.status })
			.from(projects)
			.where(isNull(projects.deletedAt))
			.orderBy(asc(projects.status), asc(projects.key))
			.limit(LIMITS.projectListMax),
		db
			.select({ id: users.id, name: users.name })
			.from(users)
			.where(eq(users.status, 'active'))
			.orderBy(asc(users.name))
			.limit(500),
		listTeamLabelsQuery(db),
		db
			.select({
				id: labels.id,
				name: labels.name,
				color: labels.color,
				projectKey: projects.key
			})
			.from(labels)
			.innerJoin(projects, eq(projects.id, labels.projectId))
			.where(
				and(
					isNull(labels.deletedAt),
					isNull(projects.deletedAt),
					filters.projects.length > 0
						? sql`${projects.key} in (select value from json_each(${keys}))`
						: undefined
				)
			)
			.orderBy(asc(projects.key), asc(labels.nameKey))
			.limit(ISSUE_LIMITS.projectLabelOptionsMax + 1),
		listViewsQuery(db, viewerId, null),
		...(one
			? [
					db
						.select({ id: milestones.id, name: milestones.name, status: milestones.status })
						.from(milestones)
						.innerJoin(projects, eq(projects.id, milestones.projectId))
						.where(
							and(eq(projects.key, one), isNull(projects.deletedAt), isNull(milestones.deletedAt))
						)
						.orderBy(desc(sql`${milestones.status} = 'open'`), asc(milestones.name))
						.limit(100)
				]
			: [])
	];
	const results = (await db.batch(
		queries as unknown as Parameters<Db['batch']>[0]
	)) as unknown as unknown[];
	const [projectRows, userRows, teamRows, labelRows, viewRows, milestoneRows] = results as [
		IssueOptions['projects'],
		IssueOptions['users'],
		(IssueOptions['teamLabels'][number] & { updatedAt: number })[],
		IssueOptions['projectLabels'],
		IssueOptions['views'],
		IssueOptions['milestones'] | undefined
	];
	return {
		projects: projectRows,
		users: userRows,
		teamLabels: teamRows.map((l) => ({ id: l.id, name: l.name, color: l.color })),
		projectLabels: labelRows.slice(0, ISSUE_LIMITS.projectLabelOptionsMax),
		moreProjectLabels: labelRows.length > ISSUE_LIMITS.projectLabelOptionsMax,
		views: viewRows.map((v) => ({ id: v.id, name: v.name, query: v.query })),
		milestones: milestoneRows ?? []
	};
}

/**
 * The filters without what no longer exists: a project key of a deleted (or never existing) project, a label id
 * that is no live label on offer, a milestone that is not one of the one chosen project's. `stale` counts them, so
 * the page can say "N filters no longer apply".
 */
export function cleanIssueFilters(
	filters: IssueFilters,
	options: IssueOptions
): { filters: IssueFilters; stale: number } {
	const keys = new Set(options.projects.map((p) => p.key));
	const labelIds = new Set([
		...options.teamLabels.map((l) => l.id),
		...options.projectLabels.map((l) => l.id)
	]);
	const projectsKept = filters.projects.filter((k) => keys.has(k));
	const labelsKept = filters.labels.filter((id) => labelIds.has(id));
	const m = filters.milestone;
	const milestoneKept =
		typeof m === 'object' &&
		!(projectsKept.length === 1 && options.milestones.some((x) => x.id === m.id))
			? ('any' as const)
			: m;
	const stale =
		filters.projects.length -
		projectsKept.length +
		(filters.labels.length - labelsKept.length) +
		(milestoneKept !== m ? 1 : 0);
	return {
		filters: { ...filters, projects: projectsKept, labels: labelsKept, milestone: milestoneKept },
		stale
	};
}

/** The WHERE clause of the list and its count, over `tasks` joined to `projects`. */
function issueWhere(filters: IssueFilters, viewerId: string, zone: string | undefined): SQL {
	const json = (v: readonly string[]) => JSON.stringify(v);
	const c: (SQL | undefined)[] = [isNull(tasks.deletedAt), isNull(projects.deletedAt)];
	if (!filters.archived) c.push(eq(projects.status, 'active'));
	if (filters.types.length > 0)
		c.push(sql`${tasks.type} in (select value from json_each(${json(filters.types)}))`);
	if (filters.statuses.length > 0)
		c.push(sql`${tasks.status} in (select value from json_each(${json(filters.statuses)}))`);
	if (filters.priorities.length > 0)
		c.push(sql`${tasks.priority} in (select value from json_each(${json(filters.priorities)}))`);
	if (filters.labels.length > 0) c.push(withAnyLabel(filters.labels));
	const a = filters.assignee;
	if (a === 'me') c.push(eq(tasks.assigneeId, viewerId));
	else if (a === 'none') c.push(isNull(tasks.assigneeId));
	else if (a !== 'any') c.push(eq(tasks.assigneeId, a.userId));
	const r = filters.reporter;
	if (r === 'me') c.push(eq(tasks.createdBy, viewerId));
	else if (r !== 'any') c.push(eq(tasks.createdBy, r.userId));
	if (filters.projects.length > 0)
		c.push(sql`${projects.key} in (select value from json_each(${json(filters.projects)}))`);
	const m = filters.milestone;
	if (m === 'none') c.push(isNull(tasks.milestoneId));
	else if (m !== 'any') c.push(eq(tasks.milestoneId, m.id));
	// Calendar dates in the team's zone, inclusive: [start of `from`, start of the day after `to`).
	const range = (column: SQLWrapper, from: string | null, to: string | null) => {
		if (from) c.push(sql`${column} >= ${zoneDayStart(from, zone)}`);
		if (to) c.push(sql`${column} < ${zoneDayStart(nextDay(to), zone)}`);
	};
	range(tasks.createdAt, filters.createdFrom, filters.createdTo);
	range(tasks.updatedAt, filters.updatedFrom, filters.updatedTo);
	return and(...c) as SQL;
}

function issueOrder(sort: IssueSort, dir: SortDir): SQL[] {
	const by = dir === 'asc' ? asc : desc;
	switch (sort) {
		case 'created':
			return [by(tasks.createdAt), by(tasks.id)];
		case 'priority':
			return [by(priorityRank), desc(tasks.updatedAt), asc(tasks.id)];
		case 'due':
			// No due date sorts last either way.
			return [sql`${tasks.dueOn} is null`, by(tasks.dueOn), asc(tasks.id)];
		default:
			return [by(tasks.updatedAt), by(tasks.id)];
	}
}

/** The page's rows query on its own (listIssues runs it; tests read its query plan). */
export function issueRowsQuery(
	db: Db,
	filters: IssueFilters,
	sort: { sort: IssueSort; dir: SortDir },
	page: number,
	viewerId: string,
	zone: string | undefined
) {
	return db
		.select({
			id: tasks.id,
			number: tasks.number,
			title: tasks.title,
			type: tasks.type,
			status: tasks.status,
			priority: tasks.priority,
			assigneeId: tasks.assigneeId,
			assigneeName: assignee.name,
			dueOn: tasks.dueOn,
			createdAt: tasks.createdAt,
			updatedAt: tasks.updatedAt,
			projectKey: projects.key,
			projectStatus: projects.status
		})
		.from(tasks)
		.innerJoin(projects, eq(projects.id, tasks.projectId))
		.leftJoin(assignee, eq(assignee.id, tasks.assigneeId))
		.where(issueWhere(filters, viewerId, zone))
		.orderBy(...issueOrder(sort.sort, sort.dir))
		.limit(ISSUE_LIMITS.pageSize)
		.offset((page - 1) * ISSUE_LIMITS.pageSize);
}

/**
 * One page (ISSUE_LIMITS.pageSize) of the matching tasks, the total (capped at ISSUE_LIMITS.countCap: a total of
 * `countCap` means "10,000+"), and the labels of the page's rows, in one round trip of four statements.
 */
export async function listIssues(
	db: Db,
	filters: IssueFilters,
	sort: { sort: IssueSort; dir: SortDir },
	page: number,
	viewerId: string,
	zone: string | undefined
): Promise<{ rows: IssueRow[]; total: number }> {
	const where = issueWhere(filters, viewerId, zone);
	const order = issueOrder(sort.sort, sort.dir);
	const offset = (page - 1) * ISSUE_LIMITS.pageSize;
	// The page's ids as a subquery (a column qualified in SQL: Drizzle drops the table name of a plain one there).
	const pageIds = db
		.select({ id: sql`${tasks.id}` })
		.from(tasks)
		.innerJoin(projects, eq(projects.id, tasks.projectId))
		.where(where)
		.orderBy(...order)
		.limit(ISSUE_LIMITS.pageSize)
		.offset(offset);
	const capped = db
		.select({ one: sql`1` })
		.from(tasks)
		.innerJoin(projects, eq(projects.id, tasks.projectId))
		.where(where)
		.limit(ISSUE_LIMITS.countCap)
		.as('capped');
	const [rows, count, labelRows, teamRows] = await db.batch([
		issueRowsQuery(db, filters, sort, page, viewerId, zone),
		db.select({ n: sql<number>`count(*)` }).from(capped),
		labelsForTasksQuery(db, sql`${pageIds}`),
		teamLabelsForTasksQuery(db, sql`${pageIds}`)
	]);
	const byTask = new Map<string, TaskLabel[]>(rows.map((r) => [r.id, []]));
	for (const l of teamRows)
		byTask.get(l.taskId)?.push({ id: l.id, name: l.name, color: l.color, scope: 'team' });
	for (const l of labelRows)
		byTask.get(l.taskId)?.push({ id: l.id, name: l.name, color: l.color, scope: 'project' });
	return {
		rows: rows.map(({ projectStatus, ...r }) => ({
			...r,
			projectArchived: projectStatus === 'archived',
			labels: byTask.get(r.id) ?? []
		})),
		total: Number(count[0]?.n ?? 0)
	};
}
