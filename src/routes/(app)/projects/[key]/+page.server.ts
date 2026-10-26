import { error, fail } from '@sveltejs/kit';
import { listActiveUsers } from '#lib/server/auth/users';
import { readFormBody, textField } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { projectFromParams } from '#lib/server/projects/route';
import { boardTasks, listTasks, moveTask } from '#lib/server/tasks/repo';
import { teamToday } from '#lib/server/tasks/today';
import {
	LIMITS,
	MESSAGES,
	parseFilters,
	parseMove,
	parsePage,
	parseSort
} from '#lib/server/tasks/validation';
import { now } from '#lib/server/util';
import { bulkUpdate } from '#lib/server/pm/bulk';
import { getColumns } from '#lib/server/pm/columns';
import { taskExtras, withExtras } from '#lib/server/pm/extras';
import { listLabels } from '#lib/server/pm/labels';
import { listTeamLabels } from '#lib/server/pm/team-labels';
import { listMilestones } from '#lib/server/pm/milestones';
import { canonicalizeQuery } from '#lib/server/pm/query';
import { pmInvalid, pmOk, pmRefused } from '#lib/server/pm/route';
import {
	idField,
	parseBulk,
	parseViewName,
	PM_LIMITS,
	PM_MESSAGES
} from '#lib/server/pm/validation';
import { deleteView, listViews, saveView } from '#lib/server/pm/views';
import { PROJECT_NOT_FOUND } from '#lib/server/projects/route';
import type { Actions, PageServerLoad } from './$types';

/**
 * A project's tasks as a filtered, sorted, paginated list (default) or, with `?view=board`, as the status board.
 * Filters live in the URL, so every view is a shareable link and works without JavaScript.
 */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const { project } = await event.parent();
	const params = event.url.searchParams;
	const view: 'list' | 'board' = params.get('view') === 'board' ? 'board' : 'list';
	const sort = parseSort(params);
	const page = parsePage(params);
	const db = event.locals.db;
	const [users, labels, teamLabels, milestones, views, columns] = await Promise.all([
		listActiveUsers(db),
		listLabels(db, project.id),
		listTeamLabels(db),
		listMilestones(db, project.id),
		listViews(db, user.id, project.id),
		view === 'board' ? getColumns(db, project.id) : null
	]);
	// RB-08: label and milestone ids that are not live in this project are dropped from the filter (RB-12: team
	// labels count as live in every project).
	const parsed = parseFilters(params);
	const labelIds = new Set([...labels, ...teamLabels].map((l) => l.id));
	const m = parsed.milestone;
	const filters = {
		...parsed,
		labels: parsed.labels.filter((id) => labelIds.has(id)),
		milestone:
			typeof m === 'object' && !milestones.some((x) => x.id === m.id) ? ('any' as const) : m
	};
	const [list, board] = await Promise.all([
		view === 'list' ? listTasks(db, project.id, filters, sort, page, user.id) : null,
		view === 'board' ? boardTasks(db, project.id, filters, user.id) : null
	]);
	const shown = list ? list.rows : (board ?? []).flatMap((c) => c.tasks);
	const extras = await taskExtras(
		db,
		project.id,
		shown.map((t) => t.id)
	);
	return {
		view,
		filters,
		sort,
		page,
		pageSize: LIMITS.pageSize,
		today: teamToday(),
		viewerId: user.id,
		users: users.map((u) => ({ id: u.id, name: u.name })),
		list: list ? { ...list, rows: withExtras(list.rows, extras) } : null,
		board: board ? board.map((c) => ({ ...c, tasks: withExtras(c.tasks, extras) })) : null,
		labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
		teamLabels: teamLabels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
		milestones: milestones.map((x) => ({ id: x.id, name: x.name, status: x.status })),
		views,
		columns: columns?.columns ?? null
	};
};

export const actions: Actions = {
	/**
	 * Moves a card: the board's no-JS form (`status` + `place`) and its drag-and-drop (`status` + `afterTaskId`)
	 * post here. The task is resolved inside this project; an archived project refuses.
	 */
	move: async (event) => {
		const { project } = await projectFromParams(event);
		const form = await readFormBody(event.request);
		const parsed = parseMove(form);
		if (!parsed.ok) return fail(400, { moveError: parsed.error });
		const moved = await moveTask(
			event.locals.db,
			project,
			parsed.taskId,
			parsed.status,
			parsed.placement,
			now()
		);
		if (moved.ok) return { moved: { taskId: parsed.taskId, status: parsed.status } };
		if (moved.reason === 'archived') return fail(409, { moveError: MESSAGES.archived });
		return fail(404, { moveError: 'That task no longer exists.' });
	},

	/**
	 * RB-08 bulk edit: up to 100 selected tasks of this project, one change set, all or nothing. Any id outside the
	 * project or deleted fails the whole request with 404 and writes nothing.
	 */
	bulk: async (event) => {
		const { user, project } = await projectFromParams(event);
		const form = await readFormBody(event.request, 32 * 1024);
		const parsed = parseBulk(form);
		if (!parsed.ok)
			return pmInvalid('bulk', parsed.errors.form ?? 'Check the changes.', {
				errors: parsed.errors as Record<string, string>
			});
		const result = await bulkUpdate(
			event.locals.db,
			user,
			project.id,
			parsed.taskIds,
			parsed.changes,
			now()
		);
		if (!result.ok) return pmRefused('bulk', result, PROJECT_NOT_FOUND);
		const n = result.updated;
		const capped =
			result.labelCapped > 0
				? ` ${result.labelCapped} already had ${result.labelCapped === 1 ? 'its' : 'their'} 10 labels and did not get the new one.`
				: '';
		// One assignee per request, so the notified people are at most one (red team L2: 10 notifications cap).
		const notified =
			result.notifySkipped > 0
				? ` 1 person was notified about the first ${PM_LIMITS.bulkNotifyMax} tasks.`
				: '';
		return pmOk('bulk', `${n} ${n === 1 ? 'task' : 'tasks'} updated.${capped}${notified}`);
	},

	/** RB-08: saves the current filters as a personal view; only whitelisted, validated keys are stored. */
	viewSave: async (event) => {
		const { user, project } = await projectFromParams(event);
		const form = await readFormBody(event.request);
		const name = parseViewName(textField(form, 'name'));
		const values = { name: textField(form, 'name').slice(0, 200) };
		if (name.error) return pmInvalid('views', name.error, { errors: { name: name.error }, values });
		const kind = textField(form, 'kind') === 'board' ? 'board' : 'list';
		const query = canonicalizeQuery(
			kind,
			new URLSearchParams(textField(form, 'query').slice(0, 4000))
		);
		if (query === null) return pmInvalid('views', PM_MESSAGES.viewTooLong, { values });
		const result = await saveView(
			event.locals.db,
			user.id,
			project.id,
			{ name: name.value, kind, query },
			now()
		);
		if (result.ok) return pmOk('views', `View “${name.value}” saved.`, result.id);
		return pmRefused('views', result, PROJECT_NOT_FOUND, { values });
	},

	/** RB-08: deletes one of the user's own views (someone else's id is not found). */
	viewDelete: async (event) => {
		const { user, project } = await projectFromParams(event);
		const form = await readFormBody(event.request);
		const id = idField(form, 'id');
		if (!id) error(404, VIEW_NOT_FOUND);
		const result = await deleteView(event.locals.db, user.id, project.id, id, now());
		if (result.ok) return pmOk('views', 'View deleted.');
		return pmRefused('views', result, VIEW_NOT_FOUND);
	}
};

const VIEW_NOT_FOUND = 'View not found.';
