import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { attachmentPanel } from '#lib/server/attachments/panel';
import { listActiveUsers, mentionNames } from '#lib/server/auth/users';
import { zoneContext } from '#lib/server/calendar/zone';
import { commentActions } from '#lib/server/comments/actions';
import { loadThread } from '#lib/server/comments/service';
import { readFormBody, textField } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { canDeleteTask } from '#lib/server/projects/permissions';
import { reminderActions, reminderPanel } from '#lib/server/reminders/panel';
import { projectFromParams, TASK_NOT_FOUND, taskNumberParam } from '#lib/server/projects/route';
import { conflictFields } from '#lib/server/tasks/conflict';
import { formatTaskRef, taskPath } from '#lib/server/tasks/format';
import {
	deleteTask,
	getTaskByNumber,
	patchTask,
	updateTask,
	type TaskDetail,
	type TaskWrite
} from '#lib/server/tasks/repo';
import { teamToday } from '#lib/server/tasks/today';
import {
	LIMITS,
	MESSAGES,
	parseExpected,
	parsePatch,
	parseTaskFields,
	type TaskFields
} from '#lib/server/tasks/validation';
import { now } from '#lib/server/util';
import { extractMentionIds } from '#lib/shared/markdown';
import {
	addItem,
	deleteItem,
	editItem,
	listItems,
	moveItem,
	toggleItem
} from '#lib/server/pm/checklist';
import { taskExtras } from '#lib/server/pm/extras';
import { listLabels, setTaskLabels } from '#lib/server/pm/labels';
import { listTeamLabels } from '#lib/server/pm/team-labels';
import { listMilestones } from '#lib/server/pm/milestones';
import { pmInvalid, pmOk, pmRefused } from '#lib/server/pm/route';
import {
	expectedField,
	idField,
	parseCheckText,
	parseLabelSets,
	PM_LIMITS,
	PM_MESSAGES
} from '#lib/server/pm/validation';
import type { Actions, PageServerLoad } from './$types';

/** The task detail: description, fields, the per-field quick changes, full edit and delete. */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const { project } = await event.parent();
	const number = taskNumberParam(event.params.number);
	const db = event.locals.db;
	const [task, users] = await Promise.all([
		getTaskByNumber(db, project.id, number),
		listActiveUsers(db)
	]);
	if (!task) error(404, TASK_NOT_FOUND);
	const [labels, teamLabels, milestones, checklist, extras] = await Promise.all([
		listLabels(db, project.id),
		// RB-12: team labels next to the project's own.
		listTeamLabels(db),
		listMilestones(db, project.id),
		listItems(db, task.id),
		taskExtras(db, project.id, [task.id])
	]);
	// Mention chips show the mentioned user's current name, never the label the author typed (red team L1).
	const [names, comments, attachments, reminders] = await Promise.all([
		mentionNames(db, extractMentionIds(task.description)),
		loadThread(db, user, { kind: 'task', id: task.id }, event.url),
		// RB-04: the task's files.
		attachmentPanel(db, user, 'task', task.id, event.url),
		// RB-09: the viewer's own reminders on this task.
		reminderPanel(db, user, { kind: 'task', id: task.id, dueOn: task.dueOn })
	]);
	return {
		attachments,
		reminders,
		clock: zoneContext(),
		names,
		/** RB-03: the comment thread (CommentThread). */
		comments,
		ref: formatTaskRef(project.key, task.number),
		task: {
			id: task.id,
			number: task.number,
			title: task.title,
			description: task.description,
			status: task.status,
			priority: task.priority,
			assigneeId: task.assigneeId,
			assigneeName: task.assigneeName,
			assigneeActive: task.assigneeActive,
			dueOn: task.dueOn,
			milestoneId: task.milestoneId,
			milestoneName: task.milestoneName,
			type: task.type,
			labels: extras.get(task.id)?.labels ?? [],
			createdByName: task.createdByName,
			createdAt: task.createdAt,
			updatedAt: task.updatedAt,
			completedAt: task.completedAt
		},
		users: users.map((u) => ({ id: u.id, name: u.name })),
		today: teamToday(),
		editing: event.url.searchParams.has('edit'),
		saved: event.url.searchParams.has('saved'),
		/** RB-12: arrived from Report an issue (`?reported=<labels applied>-<labels asked>`). */
		reported: reportedNotice(event.url.searchParams.get('reported')),
		canDelete: canDeleteTask(user, project, task),
		labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
		teamLabels: teamLabels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
		milestones: milestones.map((m) => ({ id: m.id, name: m.name, status: m.status })),
		checklist,
		pmLimits: { steps: PM_LIMITS.checklistPerTask, labels: PM_LIMITS.labelsPerTask }
	};
};

/** `?reported=A-B` (A of B labels applied) as the notice text; anything else is no notice. */
function reportedNotice(raw: string | null): { skipped: number } | null {
	const m = /^(\d{1,2})-(\d{1,2})$/.exec(raw ?? '');
	if (!m) return null;
	const applied = Number(m[1]);
	const asked = Number(m[2]);
	return applied <= asked ? { skipped: asked - applied } : null;
}

/** The project and live task an action works on, read fresh (never from the form). */
async function taskFromParams(event: RequestEvent) {
	const { user, project } = await projectFromParams(event);
	const number = taskNumberParam(event.params.number);
	const task = await getTaskByNumber(event.locals.db, project.id, number);
	if (!task) error(404, TASK_NOT_FOUND);
	return { user, project, task };
}

const storedFields = (t: TaskDetail): TaskFields => ({
	title: t.title,
	description: t.description,
	status: t.status,
	priority: t.priority,
	assigneeId: t.assigneeId,
	dueOn: t.dueOn,
	milestoneId: t.milestoneId,
	type: t.type
});

/** Display names for the conflict screen: active users and (RB-08) the project's milestones. */
async function userNames(event: RequestEvent, projectId: string): Promise<Map<string, string>> {
	const [users, milestones] = await Promise.all([
		listActiveUsers(event.locals.db),
		listMilestones(event.locals.db, projectId)
	]);
	return new Map([
		...users.map((u) => [u.id, u.name] as const),
		...milestones.map((m) => [m.id, m.name] as const)
	]);
}

/** A refused write as the page's answer: 404, 409 (archived, busy, conflict) or 400 (invalid). */
async function refusal(
	event: RequestEvent,
	result: Exclude<TaskWrite, { ok: true }>,
	kind: 'update' | 'patch',
	mine: Partial<TaskFields>,
	projectId: string
) {
	if (result.reason === 'not_found') error(404, TASK_NOT_FOUND);
	switch (result.reason) {
		case 'archived':
			return fail(409, { kind, formError: MESSAGES.archived });
		case 'busy':
			return fail(409, { kind, formError: MESSAGES.busy });
		case 'invalid':
			return fail(400, { kind, errors: result.errors, values: mine });
		case 'conflict':
			return fail(409, {
				kind,
				conflict: {
					fields: conflictFields(result.current, mine, await userNames(event, projectId)),
					mine,
					expectedUpdatedAt: result.current.updatedAt
				}
			});
	}
}

export const actions: Actions = {
	/** RB-03: `commentCreate`, `commentEdit`, `commentDelete` on this task. */
	...commentActions(async (event: RequestEvent) => {
		const { project, task } = await taskFromParams(event);
		return { kind: 'task', id: task.id, href: taskPath(project.key, task.number) };
	}),

	/** RB-09: `reminderAdd`, `reminderRemove` on this task (the viewer's own reminders). */
	...reminderActions(async (event: RequestEvent) => {
		const { task } = await taskFromParams(event);
		return { kind: 'task', id: task.id, dueOn: task.dueOn };
	}),

	/** The full edit form (title and description; any other task field posted is applied too). */
	update: async (event) => {
		const { user, project, task } = await taskFromParams(event);
		const form = await readFormBody(event.request, LIMITS.formBodyMax);
		const expected = parseExpected(textField(form, 'expectedUpdatedAt'));
		if (expected === null) return fail(400, { kind: 'update', formError: MESSAGES.stale });
		const parsed = parseTaskFields(form, storedFields(task));
		if (!parsed.ok)
			return fail(400, {
				kind: 'update',
				errors: parsed.errors,
				values: {
					title: textField(form, 'title').slice(0, LIMITS.titleMax * 4),
					description: textField(form, 'description').slice(0, LIMITS.descriptionMax + 1)
				}
			});
		const submitted = Object.fromEntries(
			Object.entries(parsed.value).filter(([k]) => form.has(k))
		) as Partial<TaskFields>;
		const result = await updateTask(
			event.locals.db,
			user,
			project,
			task,
			parsed.value,
			expected,
			now()
		);
		if (result.ok) redirect(303, `${taskPath(project.key, task.number)}?saved=1`);
		return refusal(event, result, 'update', submitted, project.id);
	},

	/** One sidebar field (status, priority, assignee, due date, milestone, type), against the version shown. */
	patch: async (event) => {
		const { user, project, task } = await taskFromParams(event);
		const form = await readFormBody(event.request, LIMITS.formBodyMax);
		const expected = parseExpected(textField(form, 'expectedUpdatedAt'));
		if (expected === null) return fail(400, { kind: 'patch', formError: MESSAGES.stale });
		const parsed = parsePatch(form);
		if (!parsed.ok)
			return fail(400, {
				kind: 'patch',
				errors: { [parsed.field ?? 'form']: parsed.error }
			});
		const result = await patchTask(
			event.locals.db,
			user,
			project,
			task,
			parsed.field,
			parsed.value,
			expected,
			now()
		);
		if (result.ok) return { kind: 'patch', patched: parsed.field };
		return refusal(event, result, 'patch', { [parsed.field]: parsed.value }, project.id);
	},

	/** Soft delete: the creator, the project lead or an admin, after ticking the confirmation box. */
	delete: async (event) => {
		const { user, project, task } = await taskFromParams(event);
		if (!canDeleteTask(user, project, task))
			error(403, 'Only the task’s creator, the project lead or an admin can delete it.');
		const form = await readFormBody(event.request);
		if (textField(form, 'confirm') !== 'yes')
			return fail(400, { kind: 'delete', deleteError: 'Tick the box to confirm.' });
		const result = await deleteTask(event.locals.db, project, task.id, now());
		if (!result.ok)
			return fail(409, {
				kind: 'delete',
				deleteError: result.reason === 'archived' ? MESSAGES.archived : MESSAGES.busy
			});
		redirect(303, `/projects/${project.key}?deleted=${formatTaskRef(project.key, task.number)}`);
	},

	// ── RB-08: labels and checklist. None of these touch `tasks.updated_at` (owner decision 8). ─────────────

	/** Replaces the task's label sets (RB-12: project and team labels, at most 10 live ones together). */
	labelsSet: async (event) => {
		const { project, task } = await taskFromParams(event);
		const form = await readFormBody(event.request);
		const ids = parseLabelSets(form);
		if (!ids.ok) return pmInvalid('labels', ids.error);
		const result = await setTaskLabels(event.locals.db, project.id, task.id, ids.value, now());
		if (result.ok) return pmOk('labels', 'Labels saved.');
		return pmRefused('labels', result, TASK_NOT_FOUND);
	},

	checkAdd: async (event) => {
		const { user, project, task } = await taskFromParams(event);
		const form = await readFormBody(event.request);
		const text = parseCheckText(textField(form, 'text'));
		const values = { text: textField(form, 'text').slice(0, 800) };
		if (text.error)
			return pmInvalid('checklist', text.error, { errors: { text: text.error }, values });
		const result = await addItem(event.locals.db, user, project.id, task.id, text.value, now());
		if (result.ok) return pmOk('checklist', 'Step added.', result.id);
		return pmRefused('checklist', result, TASK_NOT_FOUND, { values });
	},

	checkToggle: async (event) => {
		const { user, project, task } = await taskFromParams(event);
		const form = await readFormBody(event.request);
		const id = idField(form, 'id');
		if (!id) return pmInvalid('checklist', PM_MESSAGES.checkGone);
		const done = textField(form, 'done') === '1';
		const result = await toggleItem(event.locals.db, user, project.id, task.id, id, done, now());
		if (result.ok) return pmOk('checklist', done ? 'Step done.' : 'Step reopened.', id);
		return pmRefused('checklist', result, TASK_NOT_FOUND, { id });
	},

	checkEdit: async (event) => {
		const { project, task } = await taskFromParams(event);
		const form = await readFormBody(event.request);
		const id = idField(form, 'id');
		if (!id) return pmInvalid('checklist', PM_MESSAGES.checkGone);
		const expected = expectedField(form);
		if (expected === null) return pmInvalid('checklist', PM_MESSAGES.stale, { id });
		const text = parseCheckText(textField(form, 'text'));
		const values = { text: textField(form, 'text').slice(0, 800) };
		if (text.error)
			return pmInvalid('checklist', text.error, { errors: { text: text.error }, id, values });
		const result = await editItem(
			event.locals.db,
			project.id,
			task.id,
			id,
			text.value,
			expected,
			now()
		);
		if (result.ok) return pmOk('checklist', 'Step saved.', id);
		return pmRefused('checklist', result, TASK_NOT_FOUND, { id, values });
	},

	checkDelete: async (event) => {
		const { project, task } = await taskFromParams(event);
		const form = await readFormBody(event.request);
		const id = idField(form, 'id');
		if (!id) return pmInvalid('checklist', PM_MESSAGES.checkGone);
		const result = await deleteItem(event.locals.db, project.id, task.id, id, now());
		if (result.ok) return pmOk('checklist', 'Step deleted.');
		return pmRefused('checklist', result, TASK_NOT_FOUND, { id });
	},

	checkMove: async (event) => {
		const { project, task } = await taskFromParams(event);
		const form = await readFormBody(event.request);
		const id = idField(form, 'id');
		if (!id) return pmInvalid('checklist', PM_MESSAGES.checkGone);
		const direction = textField(form, 'direction');
		if (direction !== 'up' && direction !== 'down')
			return pmInvalid('checklist', PM_MESSAGES.stale, { id });
		const result = await moveItem(event.locals.db, project.id, task.id, id, direction, now());
		if (result.ok) return pmOk('checklist', 'Step moved.', id);
		return pmRefused('checklist', result, TASK_NOT_FOUND, { id });
	}
};
