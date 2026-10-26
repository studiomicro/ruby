import { AVAILABLE_SOURCES, loadCalendar, type CalendarData } from '#lib/server/calendar/repo';
import { zoneContext } from '#lib/server/calendar/zone';
import { requireUser } from '#lib/server/guards';
import { getProjectByKey, listProjects } from '#lib/server/projects/repo';
import { errorLabel } from '#lib/server/util';
import { parseCalendarFilter, viewRanges } from '#lib/shared/calendar';
import type { PageServerLoad } from './$types';

/**
 * `/calendar`: month, week or agenda of tasks and events (RB-09 PRD › Calendar). Without `view` both the month and
 * the agenda are rendered and CSS shows the agenda below 768 px. One window of at most 62 days is read; a failed read
 * shows an error banner instead of failing the page.
 */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const db = event.locals.db;
	const clock = zoneContext();
	const filter = parseCalendarFilter(event.url.searchParams, clock.today, AVAILABLE_SOURCES);
	const [project, projects] = await Promise.all([
		filter.project ? getProjectByKey(db, filter.project) : null,
		listProjects(db, { archived: false })
	]);
	if (!project) {
		filter.project = null;
		if (filter.tasks === 'project') filter.tasks = 'mine';
	}
	const ranges = viewRanges(filter.view, filter.date);
	let data: CalendarData = { items: [], capped: false };
	let loadError = false;
	try {
		data = await loadCalendar(db, user.id, filter, ranges.window, {
			projectId: project?.id ?? null,
			today: clock.today,
			zone: clock.zone
		});
	} catch (e) {
		console.error('calendar load failed', errorLabel(e));
		loadError = true;
	}
	return {
		filter,
		ranges,
		available: AVAILABLE_SOURCES,
		projects: projects.map((p) => ({ key: p.key, name: p.name })),
		items: data.items,
		capped: data.capped,
		loadError,
		deleted: event.url.searchParams.has('deleted'),
		clock
	};
};
