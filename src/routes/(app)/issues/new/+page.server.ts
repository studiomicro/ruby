import { fail, redirect } from '@sveltejs/kit';
import { TASK_PRIORITIES, TASK_TYPES, type TaskPriority, type TaskType } from '#lib/shared/enums';
import { overUserMinuteLimit } from '#lib/server/auth/throttle';
import { readFormBody, textField } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { ISSUE_LIMITS } from '#lib/server/issues/filters';
import { reportIssue, reportOptions } from '#lib/server/issues/repo';
import { parseLabelSets, PM_LIMITS } from '#lib/server/pm/validation';
import { normaliseKey } from '#lib/server/projects/validation';
import { taskPath } from '#lib/server/tasks/format';
import {
	isUuid,
	LIMITS,
	MESSAGES,
	parseTaskFields,
	type TaskFields
} from '#lib/server/tasks/validation';
import { newId, now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/**
 * Report an issue (RB-12 D7): a quick form that files a normal task in an active project (status Backlog, the
 * reporter as its creator). Deep links `?project=KEY&type=bug`; the form works without JavaScript.
 */

const oneOf = <T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T =>
	(allowed as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const p = event.url.searchParams;
	const wanted = normaliseKey(p.get('project') ?? '');
	const options = await reportOptions(event.locals.db, user.id, wanted);
	return {
		...options,
		type: oneOf<TaskType>(p.get('type'), TASK_TYPES, 'bug'),
		priority: oneOf<TaskPriority>(p.get('priority'), TASK_PRIORITIES, 'none'),
		/** The task id this form files under: a second submit of the same form finds that task. */
		submissionId: newId(),
		limits: {
			labels: PM_LIMITS.labelsPerTask,
			title: LIMITS.titleMax,
			description: LIMITS.descriptionMax
		}
	};
};

const DEFAULTS: TaskFields = {
	title: '',
	description: '',
	status: 'backlog',
	priority: 'none',
	assigneeId: null,
	dueOn: null,
	milestoneId: null,
	type: 'bug'
};

const MESSAGES_REPORT = {
	project: 'Choose a project.',
	archived: 'This project is archived.',
	slowDown: 'Slow down a little: you reported many issues in the last minute.',
	stale: 'Reload the page and try again.'
} as const;

export const actions: Actions = {
	default: async (event) => {
		const user = requireUser(event);
		const form = await readFormBody(event.request, LIMITS.formBodyMax);
		const values = {
			projectKey: textField(form, 'projectKey').slice(0, 20),
			type: textField(form, 'type').slice(0, 40),
			priority: textField(form, 'priority').slice(0, 40),
			title: textField(form, 'title').slice(0, LIMITS.titleMax * 4),
			description: textField(form, 'description').slice(0, LIMITS.descriptionMax + 1),
			submissionId: textField(form, 'submissionId').slice(0, 40),
			labelIds: form
				.getAll('labelId')
				.filter((v): v is string => typeof v === 'string')
				.slice(0, 40),
			teamLabelIds: form
				.getAll('teamLabelId')
				.filter((v): v is string => typeof v === 'string')
				.slice(0, 40)
		};
		// Only the fields this form has are read: status, assignee, due date and milestone are never taken from it.
		const fields = new FormData();
		for (const name of ['title', 'description', 'type', 'priority'])
			fields.set(name, textField(form, name));
		const parsed = parseTaskFields(fields, DEFAULTS);
		const errors: Record<string, string> = parsed.ok ? {} : { ...parsed.errors };
		const projectKey = normaliseKey(values.projectKey);
		if (!projectKey) errors.projectKey = MESSAGES_REPORT.project;
		const labels = parseLabelSets(form);
		if (!labels.ok) errors.labels = labels.error;
		const submissionId = values.submissionId.trim().toLowerCase();
		if (!isUuid(submissionId)) errors.form = MESSAGES_REPORT.stale;
		if (!parsed.ok || !projectKey || !labels.ok || errors.form)
			return fail(400, { errors, values });

		const at = now();
		if (
			await overUserMinuteLimit(
				event.locals.db,
				user.id,
				at,
				'issue-report',
				ISSUE_LIMITS.reportsPerMinute
			)
		)
			return fail(429, { errors: { form: MESSAGES_REPORT.slowDown }, values });

		const result = await reportIssue(
			event.locals.db,
			user,
			{
				projectKey,
				type: parsed.value.type,
				title: parsed.value.title,
				description: parsed.value.description,
				priority: parsed.value.priority,
				labels: labels.value,
				submissionId
			},
			at
		);
		if (result.ok)
			// The target is built from the stored task, never from the form.
			redirect(
				303,
				`${taskPath(result.key, result.number)}?reported=${result.labelsApplied}-${result.labelsAsked}`
			);
		switch (result.reason) {
			case 'not_found':
				return fail(404, { errors: { projectKey: MESSAGES_REPORT.project }, values });
			case 'archived':
				return fail(409, { errors: { projectKey: MESSAGES_REPORT.archived }, values });
			case 'invalid':
				return fail(400, { errors: result.errors as Record<string, string>, values });
			default:
				return fail(409, { errors: { form: MESSAGES.busy }, values });
		}
	}
};
