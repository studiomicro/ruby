import { CAL_LIMITS, type DateRange } from '#lib/shared/calendar';
import type { Db } from '../../db';
import { CLOSED_STATUS_LIST } from '../../projects/repo';
import { formatTaskRef, taskPath } from '../../tasks/format';
import type { SourceResult } from '../types';

/**
 * Task due dates (PRD › Sources, `task`): live tasks of live, active (not archived, O14) projects with `due_on` in the
 * window; open ones only unless `done`; mine (assignee), all, or one project's. One query on `tasks_due_idx`.
 */
export async function taskItems(
	db: Db,
	viewerId: string,
	range: DateRange,
	options: { scope: 'mine' | 'all'; projectId: string | null; done: boolean; today: string }
): Promise<SourceResult> {
	const { results } = await db.$client
		.prepare(
			`SELECT t.id, t.number, t.title, t.status, t.due_on AS dueOn, p.key FROM tasks t
			 JOIN projects p ON p.id = t.project_id
			 WHERE t.deleted_at IS NULL AND t.due_on IS NOT NULL AND t.due_on BETWEEN ?1 AND ?2
			   AND p.deleted_at IS NULL AND p.status = 'active'
			   AND (?3 = 1 OR t.status NOT IN (SELECT value FROM json_each(?4)))
			   AND (?5 = 'all' OR t.assignee_id = ?6)
			   AND (?7 IS NULL OR p.id = ?7)
			 ORDER BY t.due_on, p.key, t.number LIMIT ?8`
		)
		.bind(
			range.from,
			range.to,
			options.done ? 1 : 0,
			JSON.stringify(CLOSED_STATUS_LIST),
			options.scope,
			viewerId,
			options.projectId,
			CAL_LIMITS.sourceMax + 1
		)
		.all<{
			id: string;
			number: number;
			title: string;
			status: string;
			dueOn: string;
			key: string;
		}>();
	const closed = new Set<string>(CLOSED_STATUS_LIST);
	return {
		capped: results.length > CAL_LIMITS.sourceMax,
		items: results.slice(0, CAL_LIMITS.sourceMax).map((t) => {
			const done = closed.has(t.status);
			return {
				kind: 'task',
				key: `task-${t.id}`,
				title: `${formatTaskRef(t.key, t.number)} ${t.title}`,
				href: taskPath(t.key, t.number),
				allDay: true,
				startOn: t.dueOn,
				endOn: t.dueOn,
				startAt: null,
				endAt: null,
				overdue: !done && t.dueOn < options.today,
				done,
				private: false
			};
		})
	};
}
