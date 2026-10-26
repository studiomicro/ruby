import type { Db } from '../db';
import { progressQuery } from './checklist';
import { labelsForTasksQuery, type TaskLabel } from './labels';
import { teamLabelsForTasksQuery } from './team-labels';

/** What a list row, a board card and a My tasks row show beyond RB-01: label chips and checklist progress. */
export interface TaskExtras {
	/** RB-12: team labels first, then the task's project labels, each by name. */
	labels: TaskLabel[];
	/** Null when the task has no steps. */
	checklist: { done: number; total: number } | null;
}

type LabelRow = { taskId: string; id: string; name: string; color: TaskLabel['color'] };

/** Both kinds of label rows, merged per task (team first). */
function mergeLabels(
	out: Map<string, { labels: TaskLabel[] }>,
	teamRows: readonly LabelRow[],
	projectRows: readonly LabelRow[]
) {
	for (const r of teamRows)
		out.get(r.taskId)?.labels.push({ id: r.id, name: r.name, color: r.color, scope: 'team' });
	for (const r of projectRows)
		out.get(r.taskId)?.labels.push({ id: r.id, name: r.name, color: r.color, scope: 'project' });
}

/**
 * Labels (both kinds) and checklist progress of the shown tasks in one round trip (one `db.batch` of three grouped
 * queries, whatever the number of tasks; the ids are bound once as JSON). `projectId` null: tasks of several
 * projects.
 */
export async function taskExtras(
	db: Db,
	projectId: string | null,
	taskIds: readonly string[]
): Promise<Map<string, TaskExtras>> {
	const out = new Map<string, TaskExtras>(
		taskIds.map((id) => [id, { labels: [], checklist: null }])
	);
	if (taskIds.length === 0) return out;
	const [labelRows, teamRows, progressRows] = await db.batch([
		labelsForTasksQuery(db, taskIds),
		teamLabelsForTasksQuery(db, taskIds),
		progressQuery(db, projectId, taskIds)
	]);
	mergeLabels(out, teamRows, labelRows);
	for (const r of progressRows) {
		const entry = out.get(r.taskId);
		if (entry) entry.checklist = { done: Number(r.done ?? 0), total: Number(r.total) };
	}
	return out;
}

/** Labels only (both kinds) of the shown tasks, in one round trip of two statements (the Issues page). */
export async function taskLabelsOf(
	db: Db,
	taskIds: readonly string[]
): Promise<Map<string, TaskLabel[]>> {
	const out = new Map<string, { labels: TaskLabel[] }>(taskIds.map((id) => [id, { labels: [] }]));
	if (taskIds.length > 0) {
		const [labelRows, teamRows] = await db.batch([
			labelsForTasksQuery(db, taskIds),
			teamLabelsForTasksQuery(db, taskIds)
		]);
		mergeLabels(out, teamRows, labelRows);
	}
	return new Map([...out].map(([id, v]) => [id, v.labels]));
}

/** The rows with their extras attached (rows without an entry get none). */
export function withExtras<T extends { id: string }>(
	rows: readonly T[],
	extras: ReadonlyMap<string, TaskExtras>
): (T & TaskExtras)[] {
	return rows.map((r) => ({ ...r, ...(extras.get(r.id) ?? { labels: [], checklist: null }) }));
}
