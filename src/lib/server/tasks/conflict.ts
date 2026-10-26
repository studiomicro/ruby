import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from '#lib/shared/enums';
import type { TaskDetail } from './repo';
import type { TaskField, TaskFields } from './validation';

/**
 * The "changed meanwhile" screen: for each field where the stored task and the user's submitted values differ,
 * both values as display text, so the user can pick "Use theirs" (reload) or "Keep mine" (resubmit with the new
 * version).
 */
export interface ConflictField {
	field: TaskField;
	label: string;
	theirs: string;
	mine: string;
}

const LABELS: Record<TaskField, string> = {
	title: 'Title',
	description: 'Description',
	status: 'Status',
	priority: 'Priority',
	assigneeId: 'Assignee',
	dueOn: 'Due date',
	milestoneId: 'Milestone'
};

function display(
	field: TaskField,
	value: TaskFields[TaskField],
	names: ReadonlyMap<string, string>
): string {
	if (value === null || value === '') return field === 'description' ? '(empty)' : 'None';
	switch (field) {
		case 'status':
			return TASK_STATUS_LABELS[value as TaskFields['status']];
		case 'priority':
			return TASK_PRIORITY_LABELS[value as TaskFields['priority']];
		case 'assigneeId':
			return names.get(value) ?? 'A former user';
		case 'milestoneId':
			return names.get(value) ?? 'A deleted milestone';
		default:
			return value;
	}
}

export function conflictFields(
	current: TaskDetail,
	mine: Partial<TaskFields>,
	names: ReadonlyMap<string, string>
): ConflictField[] {
	const all = new Map(names);
	if (current.assigneeId && current.assigneeName) all.set(current.assigneeId, current.assigneeName);
	if (current.milestoneId && current.milestoneName)
		all.set(current.milestoneId, current.milestoneName);
	const out: ConflictField[] = [];
	for (const field of Object.keys(LABELS) as TaskField[]) {
		if (!(field in mine)) continue;
		const theirs = current[field] ?? null;
		const ours = mine[field] ?? null;
		if (theirs === ours) continue;
		out.push({
			field,
			label: LABELS[field],
			theirs: display(field, theirs, all),
			mine: display(field, ours, all)
		});
	}
	return out;
}
