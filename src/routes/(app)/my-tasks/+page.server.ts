import { requireUser } from '#lib/server/guards';
import { taskExtras, withExtras } from '#lib/server/pm/extras';
import { listMyTasks } from '#lib/server/tasks/repo';
import { teamToday } from '#lib/server/tasks/today';
import type { PageServerLoad } from './$types';

/** Open tasks assigned to me, grouped by due date in the team's time zone; `?closed=1` adds the latest closed. */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const closed = event.url.searchParams.get('closed') === '1';
	const today = teamToday();
	const mine = await listMyTasks(event.locals.db, user.id, { closed }, today);
	// RB-08: label chips (and the milestone, already on each row) across projects, in one more round trip.
	const all = [...Object.values(mine.groups).flat(), ...mine.closed];
	const extras = await taskExtras(
		event.locals.db,
		null,
		all.map((t) => t.id)
	);
	return {
		today,
		showClosed: closed,
		groups: {
			overdue: withExtras(mine.groups.overdue, extras),
			today: withExtras(mine.groups.today, extras),
			upcoming: withExtras(mine.groups.upcoming, extras),
			none: withExtras(mine.groups.none, extras)
		},
		closed: withExtras(mine.closed, extras)
	};
};
