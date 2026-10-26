import type { Db } from '../db';
import { progressQuery } from './checklist';
import { labelsForTasksQuery, type TaskLabel } from './labels';

/** What a list row, a board card and a My tasks row show beyond RB-01: label chips and checklist progress. */
export interface TaskExtras {
	labels: TaskLabel[];
	/** Null when the task has no steps. */
	checklist: { done: number; total: number } | null;
}

/**
 * Labels and checklist progress of the shown tasks in one round trip (one `db.batch` of two grouped queries,
 * whatever the number of tasks; the ids are bound once as JSON). `projectId` null: tasks of several projects.
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
	const [labelRows, progressRows] = await db.batch([
		labelsForTasksQuery(db, taskIds),
		progressQuery(db, projectId, taskIds)
	]);
	for (const r of labelRows)
		out.get(r.taskId)?.labels.push({ id: r.id, name: r.name, color: r.color });
	for (const r of progressRows) {
		const entry = out.get(r.taskId);
		if (entry) entry.checklist = { done: Number(r.done ?? 0), total: Number(r.total) };
	}
	return out;
}

/** The rows with their extras attached (rows without an entry get none). */
export function withExtras<T extends { id: string }>(
	rows: readonly T[],
	extras: ReadonlyMap<string, TaskExtras>
): (T & TaskExtras)[] {
	return rows.map((r) => ({ ...r, ...(extras.get(r.id) ?? { labels: [], checklist: null }) }));
}
