import { CAL_LIMITS, type DateRange } from '#lib/shared/calendar';
import type { Db } from '../../db';
import type { SourceResult } from '../types';

/**
 * RB-08 milestones on the calendar (PRD › Sources, `milestone`): live milestones (`deleted_at IS NULL`) of live,
 * active projects (archived ones are hidden, O14) with `due_on` in the window; `open` ones only unless `done`; one
 * project's when a project is chosen. All-day items on `due_on`, linking to the milestone page. One query on
 * `milestones_project_idx` / the window, at most CAL_LIMITS.sourceMax rows.
 */
export async function milestoneItems(
	db: Db,
	range: DateRange,
	options: { projectId: string | null; done: boolean }
): Promise<SourceResult> {
	const { results } = await db.$client
		.prepare(
			`SELECT m.id, m.name, m.status, m.due_on AS dueOn, p.key FROM milestones m
			 JOIN projects p ON p.id = m.project_id
			 WHERE m.deleted_at IS NULL AND m.due_on IS NOT NULL AND m.due_on BETWEEN ?1 AND ?2
			   AND p.deleted_at IS NULL AND p.status = 'active'
			   AND (?3 = 1 OR m.status = 'open')
			   AND (?4 IS NULL OR p.id = ?4)
			 ORDER BY m.due_on, p.key, m.name LIMIT ?5`
		)
		.bind(range.from, range.to, options.done ? 1 : 0, options.projectId, CAL_LIMITS.sourceMax + 1)
		.all<{ id: string; name: string; status: string; dueOn: string; key: string }>();
	return {
		capped: results.length > CAL_LIMITS.sourceMax,
		items: results.slice(0, CAL_LIMITS.sourceMax).map((m) => ({
			kind: 'milestone',
			key: `milestone-${m.id}`,
			title: `${m.key} · ${m.name}`,
			href: `/projects/${m.key}/milestones/${m.id}`,
			allDay: true,
			startOn: m.dueOn,
			endOn: m.dueOn,
			startAt: null,
			endAt: null,
			overdue: false,
			done: m.status !== 'open',
			private: false
		}))
	};
}
