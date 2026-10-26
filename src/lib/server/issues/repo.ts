import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { LabelColor, TaskPriority, TaskType } from '#lib/shared/enums';
import type { SessionUser } from '../auth/session';
import type { Db } from '../db';
import { labels, projects, tasks } from '../db/schema';
import { listTeamLabelsQuery } from '../pm/team-labels';
import { PM_LIMITS, type LabelSets } from '../pm/validation';
import { createTask } from '../tasks/repo';
import { LIMITS } from '../tasks/validation';

/**
 * Report an issue (RB-12 D7): a quick form that creates a normal task through createTask, with the reporter as
 * `created_by`, status Backlog (owner decision O3) and its labels in the same batch. The client's `submissionId` is
 * the task id, so a double submit finds the first task instead of making a second one.
 */

type Actor = Pick<SessionUser, 'id' | 'role'>;

export interface ReportInput {
	projectKey: string;
	type: TaskType;
	title: string;
	description: string;
	priority: TaskPriority;
	labels: LabelSets;
	submissionId: string;
}

export type ReportResult =
	| {
			ok: true;
			key: string;
			number: number;
			/** The labels linked; fewer than asked when one was deleted meanwhile. */
			labelsApplied: number;
			labelsAsked: number;
			/** The same submission was already filed (a double submit): this is that task. */
			repeated: boolean;
	  }
	| { ok: false; reason: 'not_found' | 'archived' | 'busy' }
	| { ok: false; reason: 'invalid'; errors: Partial<Record<'labels' | 'form', string>> };

export const REPORT_MESSAGES = {
	foreignSubmission: 'This form was already used. Reload the page and try again.',
	labels: 'Choose team labels or labels of this project.'
} as const;

/** The task the submission id names, when it exists (any project, live or not). */
async function submitted(db: Db, id: string) {
	return db
		.select({ createdBy: tasks.createdBy, number: tasks.number, key: projects.key })
		.from(tasks)
		.innerJoin(projects, eq(projects.id, tasks.projectId))
		.where(eq(tasks.id, id))
		.get();
}

export async function reportIssue(
	db: Db,
	actor: Actor,
	input: ReportInput,
	at: number
): Promise<ReportResult> {
	const { labelIds, teamLabelIds } = input.labels;
	const asked = labelIds.length + teamLabelIds.length;
	// One round trip: the project, an earlier task with this submission id, and whether every label id names a
	// label of this project or a team label (deleted ones count: they are skipped at insert time, not refused).
	const [projectRows, earlier, known] = await db.batch([
		db
			.select({ id: projects.id, status: projects.status })
			.from(projects)
			.where(and(eq(projects.key, input.projectKey), isNull(projects.deletedAt))),
		db
			.select({ createdBy: tasks.createdBy, number: tasks.number, key: projects.key })
			.from(tasks)
			.innerJoin(projects, eq(projects.id, tasks.projectId))
			.where(eq(tasks.id, input.submissionId)),
		db
			.select({
				n: sql<number>`(select count(*) from labels l join projects lp on lp.id = l.project_id where lp.key = ${input.projectKey} and l.id in (select value from json_each(${JSON.stringify(labelIds)}))) + (select count(*) from team_labels tl where tl.id in (select value from json_each(${JSON.stringify(teamLabelIds)})))`
			})
			.from(sql`(select 1)`)
	]);
	const repeat = (row: { createdBy: string; number: number; key: string } | undefined) =>
		row?.createdBy === actor.id
			? ({
					ok: true,
					key: row.key,
					number: row.number,
					labelsApplied: asked,
					labelsAsked: asked,
					repeated: true
				} as const)
			: row
				? ({
						ok: false,
						reason: 'invalid',
						errors: { form: REPORT_MESSAGES.foreignSubmission }
					} as const)
				: null;
	const before = repeat(earlier[0]);
	if (before) return before;
	const project = projectRows[0];
	if (!project) return { ok: false, reason: 'not_found' };
	if (project.status !== 'active') return { ok: false, reason: 'archived' };
	if (Number(known[0]?.n ?? 0) !== asked)
		return { ok: false, reason: 'invalid', errors: { labels: REPORT_MESSAGES.labels } };

	const created = await createTask(
		db,
		actor,
		{ id: project.id },
		{
			title: input.title,
			description: input.description,
			status: 'backlog',
			priority: input.priority,
			assigneeId: null,
			dueOn: null,
			milestoneId: null,
			type: input.type
		},
		at,
		{ id: input.submissionId, labels: input.labels }
	);
	if (created.ok)
		return {
			ok: true,
			key: input.projectKey,
			number: created.number,
			labelsApplied: created.labelsApplied,
			labelsAsked: asked,
			repeated: false
		};
	if (created.reason === 'busy') {
		// A concurrent submit of the same form won the id: answer with its task.
		const raced = repeat(await submitted(db, input.submissionId));
		if (raced) return raced;
	}
	if (created.reason === 'invalid') return { ok: false, reason: 'busy' };
	if (created.reason === 'conflict') return { ok: false, reason: 'busy' };
	return { ok: false, reason: created.reason };
}

/**
 * SQL: the key of the project the Report form starts with: `wanted` when it names an active live project, else the
 * active project of the viewer's most recent task (one lookup on `tasks_created_by_idx`), else null.
 */
const defaultProjectKey = (wanted: string | null, userId: string) =>
	sql`coalesce((select p.key from projects p where p.key = ${wanted} and p.status = 'active' and p.deleted_at is null), (select p.key from tasks t join projects p on p.id = t.project_id where t.created_by = ${userId} and t.deleted_at is null and p.status = 'active' and p.deleted_at is null order by t.created_at desc limit 1))`;

/** The live labels of an active project by key (the Report form's project group), at most 30 (RB-08's cap). */
export function projectLabelsByKeyQuery(db: Db, key: SqlKey) {
	return db
		.select({ id: labels.id, name: labels.name, color: labels.color })
		.from(labels)
		.innerJoin(projects, eq(projects.id, labels.projectId))
		.where(
			and(
				sql`${projects.key} = ${key}`,
				eq(projects.status, 'active'),
				isNull(projects.deletedAt),
				isNull(labels.deletedAt)
			)
		)
		.orderBy(asc(labels.nameKey))
		.limit(PM_LIMITS.labelsPerProject);
}
type SqlKey = string | ReturnType<typeof sql>;

export interface ReportOptions {
	projects: { key: string; name: string }[];
	teamLabels: { id: string; name: string; color: LabelColor }[];
	/** The project the form starts with (null: none chosen). */
	projectKey: string | null;
	projectLabels: { id: string; name: string; color: LabelColor }[];
}

/** What the Report form offers, in one round trip of four statements. */
export async function reportOptions(
	db: Db,
	userId: string,
	wanted: string | null
): Promise<ReportOptions> {
	const chosen = defaultProjectKey(wanted, userId);
	const [projectRows, teamRows, chosenRows, labelRows] = await db.batch([
		db
			.select({ key: projects.key, name: projects.name })
			.from(projects)
			.where(and(eq(projects.status, 'active'), isNull(projects.deletedAt)))
			.orderBy(asc(projects.key))
			.limit(LIMITS.projectListMax),
		listTeamLabelsQuery(db),
		db.select({ key: sql<string | null>`${chosen}` }).from(sql`(select 1)`),
		projectLabelsByKeyQuery(db, chosen)
	]);
	return {
		projects: projectRows,
		teamLabels: teamRows.map((l) => ({ id: l.id, name: l.name, color: l.color })),
		projectKey: chosenRows[0]?.key ?? null,
		projectLabels: labelRows
	};
}
