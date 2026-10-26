import { and, eq, isNull, sql } from 'drizzle-orm';
import { TASK_STATUS_LABELS, TASK_STATUSES, type TaskStatus } from '#lib/shared/enums';
import type { Db } from '../db';
import { batchAssert, isBatchAssertFailure } from '../db/assert';
import { projectColumns, tasks } from '../db/schema';
import { projectActive } from '../tasks/repo';
import {
	managerRefusal,
	mayManageProject,
	projectRefusal,
	type Manager,
	type PmWrite
} from './common';
import { PM_MESSAGES, type ColumnInput } from './validation';

/**
 * Per-project display settings of the six fixed board columns (RB-08): a name, a soft WIP limit and hidden. The
 * stored task status never changes. A missing row is the default; the form is saved as one set against the
 * newest `updated_at` of the project's rows, and hiding a column that holds live tasks is refused inside the write.
 */

export interface ColumnSetting {
	status: TaskStatus;
	/** What the board shows: the custom name or the status's own. */
	label: string;
	customLabel: string | null;
	wipLimit: number | null;
	hidden: boolean;
	/** Live tasks in this column (unfiltered: the WIP count). */
	taskCount: number;
}

export interface Columns {
	columns: ColumnSetting[];
	/** The newest `updated_at` of the stored rows, 0 with none: the version a save is made against. */
	version: number;
}

type Row = {
	status: TaskStatus;
	label: string | null;
	wipLimit: number | null;
	hidden: number;
	updatedAt: number;
};

/** Stored rows merged over the defaults, in board order (pure). */
export function mergeColumns(rows: readonly Row[], counts: ReadonlyMap<string, number>): Columns {
	const byStatus = new Map(rows.map((r) => [r.status, r]));
	return {
		columns: TASK_STATUSES.map((status) => {
			const r = byStatus.get(status);
			return {
				status,
				label: r?.label || TASK_STATUS_LABELS[status],
				customLabel: r?.label || null,
				wipLimit: r?.wipLimit ?? null,
				hidden: r?.hidden === 1,
				taskCount: counts.get(status) ?? 0
			};
		}),
		version: rows.reduce((v, r) => Math.max(v, r.updatedAt), 0)
	};
}

/** The project's six columns with settings and live task counts, in one round trip. */
export async function getColumns(db: Db, projectId: string): Promise<Columns> {
	const [rows, counts] = await db.batch([
		db
			.select({
				status: projectColumns.status,
				label: projectColumns.label,
				wipLimit: projectColumns.wipLimit,
				hidden: projectColumns.hidden,
				updatedAt: projectColumns.updatedAt
			})
			.from(projectColumns)
			.where(eq(projectColumns.projectId, projectId)),
		db
			.select({ status: tasks.status, n: sql<number>`count(*)` })
			.from(tasks)
			.where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
			.groupBy(tasks.status)
	]);
	return mergeColumns(rows, new Map(counts.map((c) => [c.status, Number(c.n)])));
}

/** SQL: hiding `status` is allowed: it is hidden already, or no live task uses it. */
const mayHide = (projectId: string, status: TaskStatus) =>
	sql`(exists (select 1 from project_columns pc where pc.project_id = ${projectId} and pc.status = ${status} and pc.hidden = 1) or not exists (select 1 from tasks t where t.project_id = ${projectId} and t.status = ${status} and t.deleted_at is null))`;

const version = (projectId: string) =>
	sql`(select coalesce(max(pc.updated_at), 0) from project_columns pc where pc.project_id = ${projectId})`;

/**
 * Saves all six rows at once against `expected` (Columns.version). Refused as a whole: the project is gone or
 * archived, someone saved meanwhile (conflict), or a newly hidden column holds live tasks (field errors
 * `hidden_<status>`: "N tasks use this column").
 */
export async function saveColumns(
	db: Db,
	actor: Manager,
	projectId: string,
	inputs: readonly ColumnInput[],
	expected: number,
	at: number
): Promise<PmWrite> {
	const updatedAt = Math.max(at, expected + 1);
	const hiding = inputs.filter((c) => c.hidden).map((c) => mayHide(projectId, c.status));
	try {
		await db.batch([
			batchAssert(
				db,
				sql`${projectActive(projectId)} and ${mayManageProject(projectId, actor)} and ${version(projectId)} = ${expected}${sql.join(
					hiding.map((h) => sql` and ${h}`)
				)}`
			),
			...inputs.map((c) =>
				db
					.insert(projectColumns)
					.values({
						projectId,
						status: c.status,
						label: c.label,
						wipLimit: c.wipLimit,
						hidden: c.hidden ? 1 : 0,
						updatedAt
					})
					.onConflictDoUpdate({
						target: [projectColumns.projectId, projectColumns.status],
						set: { label: c.label, wipLimit: c.wipLimit, hidden: c.hidden ? 1 : 0, updatedAt }
					})
			)
		]);
		return { ok: true };
	} catch (e) {
		if (!isBatchAssertFailure(e)) throw e;
	}
	const refused =
		(await projectRefusal(db, projectId)) ?? (await managerRefusal(db, projectId, actor));
	if (refused) return refused;
	const current = await getColumns(db, projectId);
	if (current.version !== expected)
		return { ok: false, reason: 'conflict', message: PM_MESSAGES.changed };
	const errors: Record<string, string> = {};
	for (const c of inputs) {
		const now = current.columns.find((x) => x.status === c.status);
		if (c.hidden && now && !now.hidden && now.taskCount > 0)
			errors[`hidden_${c.status}`] =
				`${now.taskCount} ${now.taskCount === 1 ? 'task uses' : 'tasks use'} this column.`;
	}
	if (Object.keys(errors).length === 0)
		return { ok: false, reason: 'conflict', message: PM_MESSAGES.changed };
	return { ok: false, reason: 'invalid', errors };
}
