import { error, fail, type RequestEvent } from '@sveltejs/kit';
import { listActiveUsers } from '#lib/server/auth/users';
import { readFormBody, textField } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { canManageProject } from '#lib/server/projects/permissions';
import { setProjectArchived, updateProject, type ProjectWrite } from '#lib/server/projects/repo';
import { PROJECT_NOT_FOUND, projectFromParams } from '#lib/server/projects/route';
import { parseProjectEdit } from '#lib/server/projects/validation';
import { LIMITS, parseExpected } from '#lib/server/tasks/validation';
import { now } from '#lib/server/util';
import { teamToday } from '#lib/server/tasks/today';
import { getColumns, saveColumns } from '#lib/server/pm/columns';
import { createLabel, deleteLabel, listLabels, updateLabel } from '#lib/server/pm/labels';
import {
	createMilestone,
	deleteMilestone,
	listMilestones,
	setMilestoneStatus,
	updateMilestone
} from '#lib/server/pm/milestones';
import { pmInvalid, pmOk, pmRefused } from '#lib/server/pm/route';
import {
	expectedField,
	idField,
	parseColumns,
	parseLabel,
	parseMilestone,
	PM_MESSAGES
} from '#lib/server/pm/validation';
import type { Actions, PageServerLoad } from './$types';

const CHANGED = 'This project was changed meanwhile. The form now shows the current version.';
const NOT_ALLOWED = 'Only the project lead, its creator or an admin can change this project.';

export const load: PageServerLoad = async (event) => {
	requireUser(event);
	await event.parent();
	const { project } = await event.parent();
	const db = event.locals.db;
	const [users, labels, milestones, columns] = await Promise.all([
		listActiveUsers(db),
		listLabels(db, project.id),
		listMilestones(db, project.id),
		getColumns(db, project.id)
	]);
	return {
		users: users.map((u) => ({ id: u.id, name: u.name })),
		labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color, updatedAt: l.updatedAt })),
		milestones,
		columns,
		today: teamToday()
	};
};

const LABEL_NOT_FOUND = 'Label not found.';
const MILESTONE_NOT_FOUND = 'Milestone not found.';
/**
 * Body bound of the milestone form: a valid 1,000-character description can be 4 UTF-8 bytes per character, 12
 * once URL-encoded, plus the name; the 8 KiB default would refuse it.
 */
const MILESTONE_FORM_MAX = 32 * 1024;

/** The project for a settings action, after the manage rule (lead, creator or admin) on a fresh read. */
async function managed(event: RequestEvent) {
	const { user, project } = await projectFromParams(event);
	if (!canManageProject(user, project)) error(403, NOT_ALLOWED);
	return { user, project };
}

function refused(result: Exclude<ProjectWrite, { ok: true }>, values?: Record<string, string>) {
	if (result.reason === 'not_found') error(404, PROJECT_NOT_FOUND);
	if (result.reason === 'forbidden') error(403, NOT_ALLOWED);
	if (result.reason === 'conflict') return fail(409, { errors: { form: CHANGED } });
	return fail(400, { errors: result.errors ?? {}, values });
}

export const actions: Actions = {
	/** Name, description and lead; the key is fixed (a posted `key` is ignored). */
	update: async (event) => {
		const { user, project } = await managed(event);
		const form = await readFormBody(event.request, LIMITS.formBodyMax);
		const parsed = parseProjectEdit(form);
		if (!parsed.ok) return fail(400, { errors: parsed.errors, values: parsed.echo });
		const result = await updateProject(
			event.locals.db,
			user,
			project.id,
			parsed.value,
			parsed.expected,
			now()
		);
		if (result.ok) return { saved: 'Project saved.' };
		return refused(result, {
			name: parsed.value.name,
			description: parsed.value.description,
			leadId: parsed.value.leadId ?? ''
		});
	},
	archive: (event) => setArchived(event, true),
	unarchive: (event) => setArchived(event, false),

	/** RB-08: creates a label (any active user) or, with `id`, renames and recolours one (managers only). */
	labelSave: async (event) => {
		const { user, project } = await projectFromParams(event);
		const form = await readFormBody(event.request);
		const id = textField(form, 'id') === '' ? null : idField(form, 'id');
		if (textField(form, 'id') !== '' && !id) error(404, LABEL_NOT_FOUND);
		if (id && !canManageProject(user, project)) error(403, NOT_ALLOWED);
		const values = { name: textField(form, 'name').slice(0, 200), color: textField(form, 'color') };
		const parsed = parseLabel(form);
		if (!parsed.ok)
			return pmInvalid('labels', 'Check the label.', {
				errors: parsed.errors as Record<string, string>,
				id: id ?? undefined,
				values
			});
		const db = event.locals.db;
		if (!id) {
			const created = await createLabel(db, user, project.id, parsed.value, now());
			if (created.ok) return pmOk('labels', `Label “${parsed.value.name}” added.`);
			return pmRefused('labels', created, PROJECT_NOT_FOUND, { values });
		}
		const expected = expectedField(form);
		if (expected === null) return pmInvalid('labels', PM_MESSAGES.stale, { id });
		const updated = await updateLabel(db, user, project.id, id, parsed.value, expected, now());
		if (updated.ok) return pmOk('labels', 'Label saved.', id);
		return pmRefused('labels', updated, LABEL_NOT_FOUND, { id, values });
	},

	/** RB-08: soft-deletes a label (managers only); it leaves every task, filter and card. */
	labelDelete: async (event) => {
		const { user, project } = await managed(event);
		const form = await readFormBody(event.request);
		const id = idField(form, 'id');
		if (!id) error(404, LABEL_NOT_FOUND);
		const result = await deleteLabel(event.locals.db, user, project.id, id, now());
		if (result.ok) return pmOk('labels', 'Label deleted.');
		return pmRefused('labels', result, LABEL_NOT_FOUND, { id });
	},

	/** RB-08: creates a milestone or, with `id`, edits one against its version (managers only). */
	milestoneSave: async (event) => {
		const { user, project } = await managed(event);
		const form = await readFormBody(event.request, MILESTONE_FORM_MAX);
		const raw = textField(form, 'id');
		const id = raw === '' ? null : idField(form, 'id');
		if (raw !== '' && !id) error(404, MILESTONE_NOT_FOUND);
		const values = {
			name: textField(form, 'name').slice(0, 400),
			description: textField(form, 'description').slice(0, 4000),
			dueOn: textField(form, 'dueOn').slice(0, 20)
		};
		const parsed = parseMilestone(form);
		if (!parsed.ok)
			return pmInvalid('milestones', 'Check the milestone.', {
				errors: parsed.errors as Record<string, string>,
				id: id ?? undefined,
				values
			});
		const db = event.locals.db;
		if (!id) {
			const created = await createMilestone(db, user, project.id, parsed.value, now());
			if (created.ok) return pmOk('milestones', `Milestone “${parsed.value.name}” added.`);
			return pmRefused('milestones', created, PROJECT_NOT_FOUND, { values });
		}
		const expected = expectedField(form);
		if (expected === null) return pmInvalid('milestones', PM_MESSAGES.stale, { id });
		const updated = await updateMilestone(db, user, project.id, id, parsed.value, expected, now());
		if (updated.ok) return pmOk('milestones', 'Milestone saved.', id);
		return pmRefused('milestones', updated, MILESTONE_NOT_FOUND, { id, values });
	},

	/** RB-08: closes or reopens a milestone (managers only). */
	milestoneStatus: async (event) => {
		const { user, project } = await managed(event);
		const form = await readFormBody(event.request);
		const id = idField(form, 'id');
		if (!id) error(404, MILESTONE_NOT_FOUND);
		const status = textField(form, 'status');
		if (status !== 'open' && status !== 'closed')
			return pmInvalid('milestones', PM_MESSAGES.stale, { id });
		const expected = expectedField(form);
		if (expected === null) return pmInvalid('milestones', PM_MESSAGES.stale, { id });
		const result = await setMilestoneStatus(
			event.locals.db,
			user,
			project.id,
			id,
			status,
			expected,
			now()
		);
		if (result.ok)
			return pmOk(
				'milestones',
				status === 'closed' ? 'Milestone closed.' : 'Milestone reopened.',
				id
			);
		return pmRefused('milestones', result, MILESTONE_NOT_FOUND, { id });
	},

	/** RB-08: soft-deletes a milestone and unlinks its tasks (managers only). */
	milestoneDelete: async (event) => {
		const { user, project } = await managed(event);
		const form = await readFormBody(event.request);
		const id = idField(form, 'id');
		if (!id) error(404, MILESTONE_NOT_FOUND);
		const result = await deleteMilestone(event.locals.db, user, project.id, id, now());
		if (result.ok) return pmOk('milestones', 'Milestone deleted.');
		return pmRefused('milestones', result, MILESTONE_NOT_FOUND, { id });
	},

	/** RB-08: the six board columns' names, WIP limits and hidden flags, saved as one set (managers only). */
	columnsSave: async (event) => {
		const { user, project } = await managed(event);
		const form = await readFormBody(event.request);
		const expected = expectedField(form);
		if (expected === null) return pmInvalid('columns', PM_MESSAGES.stale);
		const parsed = parseColumns(form);
		if (!parsed.ok)
			return pmInvalid('columns', 'Check the columns.', {
				errors: parsed.errors as Record<string, string>
			});
		const result = await saveColumns(
			event.locals.db,
			user,
			project.id,
			parsed.value,
			expected,
			now()
		);
		if (result.ok) return pmOk('columns', 'Board columns saved.');
		if (result.reason === 'invalid')
			return pmInvalid('columns', 'A column that holds tasks cannot be hidden.', {
				errors: result.errors
			});
		return pmRefused('columns', result, PROJECT_NOT_FOUND);
	}
};

async function setArchived(event: RequestEvent, archived: boolean) {
	const { user, project } = await managed(event);
	const form = await readFormBody(event.request);
	const expected = parseExpected(textField(form, 'expectedUpdatedAt'));
	if (expected === null) return fail(400, { errors: { form: CHANGED } });
	const result = await setProjectArchived(
		event.locals.db,
		user,
		project.id,
		archived,
		expected,
		now()
	);
	if (result.ok) return { saved: archived ? 'Project archived.' : 'Project unarchived.' };
	return refused(result);
}
