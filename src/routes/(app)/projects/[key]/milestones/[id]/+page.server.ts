import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/guards';
import {
	getMilestone,
	milestoneProgress,
	milestoneTasks,
	progressFrom
} from '#lib/server/pm/milestones';
import { teamToday } from '#lib/server/tasks/today';
import { isUuid } from '#lib/server/tasks/validation';
import type { PageServerLoad } from './$types';

const NOT_FOUND = 'Milestone not found.';

/** A milestone: due date, progress (done over non-canceled tasks) and its tasks by status. Read-only. */
export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const { project } = await event.parent();
	const id = event.params.id;
	if (!isUuid(id)) error(404, NOT_FOUND);
	const db = event.locals.db;
	const milestone = await getMilestone(db, project.id, id.toLowerCase());
	if (!milestone) error(404, NOT_FOUND);
	const [progress, tasks] = await Promise.all([
		milestoneProgress(db, project.id),
		milestoneTasks(db, project.id, milestone.id)
	]);
	return {
		milestone,
		progress: progress.get(milestone.id) ?? progressFrom(new Map()),
		tasks,
		today: teamToday()
	};
};
