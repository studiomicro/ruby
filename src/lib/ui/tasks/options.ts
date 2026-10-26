import {
	TASK_PRIORITIES,
	TASK_PRIORITY_LABELS,
	TASK_STATUSES,
	TASK_STATUS_LABELS,
	type TaskStatus
} from '#lib/shared/enums';

/** Select options for the task enums, in display order. */
export const STATUS_OPTIONS = TASK_STATUSES.map((s) => ({
	value: s,
	label: TASK_STATUS_LABELS[s]
}));
export const PRIORITY_OPTIONS = [...TASK_PRIORITIES]
	.reverse()
	.map((p) => ({ value: p, label: TASK_PRIORITY_LABELS[p] }));

export const statusTone = (s: TaskStatus) =>
	s === 'done'
		? 'success'
		: s === 'canceled' || s === 'backlog'
			? 'neutral'
			: s === 'in_review'
				? 'warning'
				: 'accent';

export const isClosedStatus = (s: TaskStatus) => s === 'done' || s === 'canceled';

/** Overdue: an open task whose due date is before the team's today (both `YYYY-MM-DD`). */
export const isOverdue = (t: { dueOn: string | null; status: TaskStatus }, today: string) =>
	!!t.dueOn && t.dueOn < today && !isClosedStatus(t.status);

/** `2026-10-26` as `Oct 26` (or `Oct 26, 2027` outside `today`'s year). A calendar date: no time zone shift. */
export function formatDue(dueOn: string, today: string): string {
	const [y, m, d] = dueOn.split('-').map(Number) as [number, number, number];
	const date = new Date(Date.UTC(y, m - 1, d));
	return date.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
		...(dueOn.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' })
	});
}

export type UserOption = { id: string; name: string };

/** Assignee/lead options: nobody, every active user, and a current (now disabled) one kept as it is. */
export function peopleOptions(
	users: readonly UserOption[],
	current: { id: string | null; name: string | null } | null,
	noneLabel = 'Nobody'
) {
	const options = [
		{ value: '', label: noneLabel },
		...users.map((u) => ({ value: u.id, label: u.name }))
	];
	if (current?.id && !users.some((u) => u.id === current.id))
		options.push({ value: current.id, label: `${current.name ?? 'Former user'} (disabled)` });
	return options;
}
