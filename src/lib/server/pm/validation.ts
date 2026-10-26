import {
	LABEL_COLORS,
	TASK_PRIORITIES,
	TASK_STATUSES,
	TASK_TYPES,
	type LabelColor,
	type TaskPriority,
	type TaskStatus,
	type TaskType
} from '#lib/shared/enums';
import { textField } from '../forms';
import { isValidDueOn } from '../tasks/dates';
import { cleanBody, cleanLine, isUuid, parseExpected } from '../tasks/validation';

/**
 * RB-08 form validation (labels, checklist steps, milestones, board columns, saved views, bulk edit). Plain
 * functions like RB-01's; every limit lives in PM_LIMITS and the server is the rule (client `maxlength` mirrors it).
 */
export const PM_LIMITS = {
	labelNameMax: 30,
	labelsPerProject: 30,
	labelsPerTask: 10,
	checklistTextMax: 200,
	checklistPerTask: 50,
	milestoneNameMax: 80,
	milestoneDescriptionMax: 1000,
	milestonesPerProject: 50,
	/** Tasks a milestone page lists at most. */
	milestoneTasksMax: 500,
	columnLabelMax: 24,
	wipMin: 1,
	wipMax: 200,
	viewNameMax: 40,
	viewsPerUserProject: 20,
	viewQueryMax: 500,
	bulkMax: 100,
	/** `assigned` notifications one bulk request writes at most (one recipient per request; red team L2). */
	bulkNotifyMax: 10,
	/** RB-12: live team labels (workspace-wide, admins manage them). */
	teamLabelsMax: 100,
	/** RB-12: stored query of an Issues view (more keys than a project view; worst case about 900). */
	issueViewQueryMax: 1000
} as const;

export const PM_MESSAGES = {
	labelName: 'Enter a label name.',
	labelNameTooLong: `Keep the label name to ${PM_LIMITS.labelNameMax} characters.`,
	labelColor: 'Choose one of the colours.',
	labelTaken: 'This project already has a label with that name.',
	labelLimit: `A project can have up to ${PM_LIMITS.labelsPerProject} labels.`,
	labelsPerTask: `A task can have up to ${PM_LIMITS.labelsPerTask} labels.`,
	labelUnknown: 'Choose labels of this project.',
	teamLabelTaken: 'That label already exists.',
	teamLabelLimit: `The team can have up to ${PM_LIMITS.teamLabelsMax} team labels.`,
	teamLabelUnknown: 'Choose a team label that still exists.',
	notAdmin: 'Only admins can change team labels.',
	checkText: 'Enter the step.',
	checkTextTooLong: `Keep a step to ${PM_LIMITS.checklistTextMax} characters.`,
	checkLimit: `A task can have up to ${PM_LIMITS.checklistPerTask} steps.`,
	checkGone: 'That step no longer exists.',
	milestoneName: 'Enter a milestone name.',
	milestoneNameTooLong: `Keep the name to ${PM_LIMITS.milestoneNameMax} characters.`,
	milestoneDescriptionTooLong: `Keep the description to ${PM_LIMITS.milestoneDescriptionMax.toLocaleString('en-US')} characters.`,
	milestoneLimit: `A project can have up to ${PM_LIMITS.milestonesPerProject} milestones.`,
	dueOn: 'Enter a date between 2000-01-01 and 2100-12-31.',
	columnLabelTooLong: `Keep a column name to ${PM_LIMITS.columnLabelMax} characters.`,
	wip: `Enter a whole number from ${PM_LIMITS.wipMin} to ${PM_LIMITS.wipMax}, or leave it empty.`,
	viewName: 'Enter a name for the view.',
	viewNameTooLong: `Keep the name to ${PM_LIMITS.viewNameMax} characters.`,
	viewTaken: 'You already have a view with that name.',
	viewLimit: `You can save up to ${PM_LIMITS.viewsPerUserProject} views per project.`,
	issueViewLimit: `You can save up to ${PM_LIMITS.viewsPerUserProject} issue views.`,
	viewTooLong: 'Too many filters to save in one view. Remove a few and try again.',
	bulkNone: 'Select at least one task.',
	bulkTooMany: `Select at most ${PM_LIMITS.bulkMax} tasks at once.`,
	bulkNoChange: 'Choose at least one change.',
	bulkGone: 'Some tasks no longer exist, reload.',
	stale: 'Reload the page and try again.',
	changed: 'This was changed meanwhile. The page now shows the current version.'
} as const;

type Line = { value: string; error?: string };

function line(raw: string, max: number, required: string, tooLong: string): Line {
	const { value, tooLong: over } = cleanLine(raw, max);
	if (!value) return { value, error: required };
	return over ? { value, error: tooLong } : { value };
}

/** The case-insensitive key a label name is unique by (`Bug` and `bug` clash). */
export const labelNameKey = (name: string): string => name.normalize('NFC').toLowerCase();

export interface LabelInput {
	name: string;
	nameKey: string;
	color: LabelColor;
}

export function parseLabel(
	form: FormData
): { ok: true; value: LabelInput } | { ok: false; errors: { name?: string; color?: string } } {
	const name = line(
		textField(form, 'name'),
		PM_LIMITS.labelNameMax,
		PM_MESSAGES.labelName,
		PM_MESSAGES.labelNameTooLong
	);
	const color = textField(form, 'color');
	const errors: { name?: string; color?: string } = {};
	if (name.error) errors.name = name.error;
	if (!(LABEL_COLORS as readonly string[]).includes(color)) errors.color = PM_MESSAGES.labelColor;
	if (errors.name || errors.color) return { ok: false, errors };
	return {
		ok: true,
		value: { name: name.value, nameKey: labelNameKey(name.value), color: color as LabelColor }
	};
}

/** A uuid form field, lower-cased; null when missing or malformed. */
export function idField(form: FormData, name: string): string | null {
	const v = textField(form, name).trim();
	return isUuid(v) ? v.toLowerCase() : null;
}

/** `expectedUpdatedAt` of a form, or null. */
export const expectedField = (form: FormData): number | null =>
	parseExpected(textField(form, 'expectedUpdatedAt'));

/** A task's two label sets (RB-12): project labels and team labels, replaced together. */
export interface LabelSets {
	labelIds: string[];
	teamLabelIds: string[];
}

/**
 * The label sets of a task's labels form (`labelId` project labels, `teamLabelId` team labels): distinct uuids, at
 * most PM_LIMITS.labelsPerTask in total (owner decision O6: project and team labels count together).
 */
export function parseLabelSets(
	form: FormData
): { ok: true; value: LabelSets } | { ok: false; error: string } {
	const read = (name: string) =>
		form.getAll(name).filter((v): v is string => typeof v === 'string');
	const rawProject = read('labelId');
	const rawTeam = read('teamLabelId');
	if (rawProject.length + rawTeam.length > PM_LIMITS.labelsPerTask * 4)
		return { ok: false, error: PM_MESSAGES.labelsPerTask };
	if (!rawProject.every((v) => isUuid(v.trim())))
		return { ok: false, error: PM_MESSAGES.labelUnknown };
	if (!rawTeam.every((v) => isUuid(v.trim())))
		return { ok: false, error: PM_MESSAGES.teamLabelUnknown };
	const distinct = (raw: string[]) => [...new Set(raw.map((v) => v.trim().toLowerCase()))];
	const value = { labelIds: distinct(rawProject), teamLabelIds: distinct(rawTeam) };
	if (value.labelIds.length + value.teamLabelIds.length > PM_LIMITS.labelsPerTask)
		return { ok: false, error: PM_MESSAGES.labelsPerTask };
	return { ok: true, value };
}

export function parseCheckText(raw: string): Line {
	return line(raw, PM_LIMITS.checklistTextMax, PM_MESSAGES.checkText, PM_MESSAGES.checkTextTooLong);
}

export interface MilestoneInput {
	name: string;
	description: string;
	dueOn: string | null;
}
type MilestoneErrors = Partial<Record<'name' | 'description' | 'dueOn', string>>;

export function parseMilestone(
	form: FormData
): { ok: true; value: MilestoneInput } | { ok: false; errors: MilestoneErrors } {
	const errors: MilestoneErrors = {};
	const name = line(
		textField(form, 'name'),
		PM_LIMITS.milestoneNameMax,
		PM_MESSAGES.milestoneName,
		PM_MESSAGES.milestoneNameTooLong
	);
	if (name.error) errors.name = name.error;
	const description = cleanBody(textField(form, 'description'));
	// Characters are code points (an emoji is one), like every other RB-08 length limit.
	if (Array.from(description).length > PM_LIMITS.milestoneDescriptionMax)
		errors.description = PM_MESSAGES.milestoneDescriptionTooLong;
	const due = textField(form, 'dueOn').trim();
	if (due !== '' && !isValidDueOn(due)) errors.dueOn = PM_MESSAGES.dueOn;
	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, value: { name: name.value, description, dueOn: due === '' ? null : due } };
}

// ── Board columns ───────────────────────────────────────────────────────────────────────────────────────────

export interface ColumnInput {
	status: TaskStatus;
	/** Null: the status's own name. */
	label: string | null;
	wipLimit: number | null;
	hidden: boolean;
}

/** A WIP limit field: empty is none; otherwise a whole number 1-200 (`0`, `201`, `2.5`, `1e2` are refused). */
export function parseWip(raw: string): { ok: true; value: number | null } | { ok: false } {
	const v = raw.trim();
	if (v === '') return { ok: true, value: null };
	if (!/^\d{1,3}$/.test(v)) return { ok: false };
	const n = Number(v);
	return n >= PM_LIMITS.wipMin && n <= PM_LIMITS.wipMax ? { ok: true, value: n } : { ok: false };
}

/**
 * The board-columns form: per status `label_<status>`, `wip_<status>` and the checkbox `hidden_<status>`. A missing
 * field means the default (so "reset" is an empty row).
 */
export function parseColumns(
	form: FormData
): { ok: true; value: ColumnInput[] } | { ok: false; errors: Partial<Record<string, string>> } {
	const errors: Partial<Record<string, string>> = {};
	const value: ColumnInput[] = [];
	for (const status of TASK_STATUSES) {
		const { value: label, tooLong } = cleanLine(
			textField(form, `label_${status}`),
			PM_LIMITS.columnLabelMax
		);
		if (tooLong) errors[`label_${status}`] = PM_MESSAGES.columnLabelTooLong;
		const wip = parseWip(textField(form, `wip_${status}`));
		if (!wip.ok) errors[`wip_${status}`] = PM_MESSAGES.wip;
		value.push({
			status,
			label: label === '' ? null : label,
			wipLimit: wip.ok ? wip.value : null,
			hidden: textField(form, `hidden_${status}`) === 'on'
		});
	}
	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, value };
}

export function parseViewName(raw: string): Line {
	return line(raw, PM_LIMITS.viewNameMax, PM_MESSAGES.viewName, PM_MESSAGES.viewNameTooLong);
}

// ── Bulk edit ───────────────────────────────────────────────────────────────────────────────────────────────

/** What a bulk edit changes; a missing key is left as it is. `null` clears an assignee, milestone or due date. */
export interface BulkChanges {
	status?: TaskStatus;
	priority?: TaskPriority;
	/** RB-12. */
	type?: TaskType;
	assigneeId?: string | null;
	milestoneId?: string | null;
	dueOn?: string | null;
	addLabelId?: string;
	removeLabelId?: string;
	/** RB-12: team labels (any project). */
	addTeamLabelId?: string;
	removeTeamLabelId?: string;
}
export type BulkField = keyof BulkChanges;

/**
 * The fields the cross-project Issues bulk bar may change (RB-12 D6, owner decision O10): milestones and project
 * labels belong to one project, so they stay in the project list's bulk bar.
 */
export const ISSUE_BULK_FIELDS: readonly BulkField[] = [
	'status',
	'priority',
	'type',
	'assigneeId',
	'dueOn',
	'addTeamLabelId',
	'removeTeamLabelId'
];

/**
 * The bulk form: `taskId` (repeated, 1-100 distinct uuids) and the change selects. An empty select means "no
 * change"; `none` clears an assignee or milestone; the `clearDue` checkbox clears the due date.
 */
export function parseBulk(
	form: FormData,
	/** The fields this bulk bar may change (RB-12: the Issues bar has fewer); another one posted is refused. */
	allowed: readonly BulkField[] | null = null
):
	| { ok: true; taskIds: string[]; changes: BulkChanges }
	| { ok: false; errors: Partial<Record<BulkField | 'form', string>> } {
	const errors: Partial<Record<BulkField | 'form', string>> = {};
	const raw = form.getAll('taskId').filter((v): v is string => typeof v === 'string');
	const valid = raw.length <= PM_LIMITS.bulkMax * 4 && raw.every((v) => isUuid(v.trim()));
	const taskIds = valid ? [...new Set(raw.map((v) => v.trim().toLowerCase()))] : [];
	if (!valid) errors.form = PM_MESSAGES.bulkGone;
	else if (taskIds.length === 0) errors.form = PM_MESSAGES.bulkNone;
	else if (taskIds.length > PM_LIMITS.bulkMax) errors.form = PM_MESSAGES.bulkTooMany;

	const changes: BulkChanges = {};
	const status = textField(form, 'status');
	if (status !== '') {
		if ((TASK_STATUSES as readonly string[]).includes(status))
			changes.status = status as TaskStatus;
		else errors.status = 'Choose a status.';
	}
	const priority = textField(form, 'priority');
	if (priority !== '') {
		if ((TASK_PRIORITIES as readonly string[]).includes(priority))
			changes.priority = priority as TaskPriority;
		else errors.priority = 'Choose a priority.';
	}
	const type = textField(form, 'type');
	if (type !== '') {
		if ((TASK_TYPES as readonly string[]).includes(type)) changes.type = type as TaskType;
		else errors.type = 'Choose a type.';
	}
	const ref = (name: 'assigneeId' | 'milestoneId', message: string) => {
		const v = textField(form, name).trim();
		if (v === '') return;
		if (v === 'none') changes[name] = null;
		else if (isUuid(v)) changes[name] = v.toLowerCase();
		else errors[name] = message;
	};
	ref('assigneeId', 'Choose an active teammate or nobody.');
	ref('milestoneId', 'Choose an open milestone of this project or none.');
	if (textField(form, 'clearDue') === 'on') changes.dueOn = null;
	else {
		const due = textField(form, 'dueOn').trim();
		if (due !== '') {
			if (isValidDueOn(due)) changes.dueOn = due;
			else errors.dueOn = PM_MESSAGES.dueOn;
		}
	}
	for (const name of [
		'addLabelId',
		'removeLabelId',
		'addTeamLabelId',
		'removeTeamLabelId'
	] as const) {
		const v = textField(form, name).trim();
		if (v === '') continue;
		if (isUuid(v)) changes[name] = v.toLowerCase();
		else
			errors[name] = name.includes('Team')
				? PM_MESSAGES.teamLabelUnknown
				: PM_MESSAGES.labelUnknown;
	}
	if (
		changes.addLabelId !== undefined &&
		changes.addLabelId === changes.removeLabelId &&
		!errors.addLabelId
	)
		errors.removeLabelId = 'Add and remove a different label.';
	if (
		changes.addTeamLabelId !== undefined &&
		changes.addTeamLabelId === changes.removeTeamLabelId &&
		!errors.addTeamLabelId
	)
		errors.removeTeamLabelId = 'Add and remove a different label.';
	if (allowed)
		for (const name of Object.keys(changes) as BulkField[])
			if (!allowed.includes(name)) {
				delete changes[name];
				errors.form = 'Milestones and project labels can only be changed inside one project.';
			}
	if (Object.keys(errors).length === 0 && Object.keys(changes).length === 0)
		errors.form = PM_MESSAGES.bulkNoChange;
	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, taskIds, changes };
}
