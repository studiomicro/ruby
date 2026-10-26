import { error, fail, redirect } from '@sveltejs/kit';
import { TASK_STATUSES, TASK_TYPES, type TaskStatus, type TaskType } from '#lib/shared/enums';
import { listActiveUsers } from '#lib/server/auth/users';
import { readFormBody, textField } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { PROJECT_NOT_FOUND, projectFromParams } from '#lib/server/projects/route';
import { taskPath } from '#lib/server/tasks/format';
import { createTask } from '#lib/server/tasks/repo';
import { LIMITS, MESSAGES, parseTaskFields } from '#lib/server/tasks/validation';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

const DEFAULTS = {
	title: '',
	description: '',
	status: 'todo',
	priority: 'none',
	assigneeId: null,
	dueOn: null,
	milestoneId: null,
	type: 'task'
} as const;

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	await event.parent();
	const preset = event.url.searchParams.get('status') ?? '';
	const status: TaskStatus = (TASK_STATUSES as readonly string[]).includes(preset)
		? (preset as TaskStatus)
		: 'todo';
	// RB-12: `?type=bug` presets the type (default Task).
	const typePreset = event.url.searchParams.get('type') ?? '';
	const type: TaskType = (TASK_TYPES as readonly string[]).includes(typePreset)
		? (typePreset as TaskType)
		: 'task';
	const users = await listActiveUsers(event.locals.db);
	return { status, type, users: users.map((u) => ({ id: u.id, name: u.name })), selfId: user.id };
};

export const actions: Actions = {
	/** Any active user may create a task in an active project; it gets the project's next number. */
	default: async (event) => {
		const { user, project } = await projectFromParams(event);
		const form = await readFormBody(event.request, LIMITS.formBodyMax);
		const values = Object.fromEntries(
			['title', 'description', 'type', 'status', 'priority', 'assigneeId', 'dueOn'].map((n) => [
				n,
				textField(form, n).slice(0, LIMITS.descriptionMax + 1)
			])
		);
		const parsed = parseTaskFields(form, { ...DEFAULTS });
		if (!parsed.ok) return fail(400, { errors: parsed.errors, values });
		const created = await createTask(event.locals.db, user, project, parsed.value, now());
		if (created.ok) redirect(303, taskPath(project.key, created.number));
		if (created.reason === 'not_found') error(404, PROJECT_NOT_FOUND);
		switch (created.reason) {
			case 'archived':
				return fail(409, { errors: { form: MESSAGES.archived }, values });
			case 'busy':
				return fail(409, { errors: { form: MESSAGES.busy }, values });
			case 'invalid':
				return fail(400, { errors: created.errors, values });
			default:
				return fail(409, { errors: { form: MESSAGES.stale }, values });
		}
	}
};
