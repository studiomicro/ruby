import type { CalendarItem } from '#lib/shared/calendar-items';
import type { IconName } from '#lib/ui/kit/Icon.svelte';

/** Every item kind has an icon and a text label: colour is never the only signal. */
export const KIND_LABEL: Record<CalendarItem['kind'], string> = {
	task: 'Task',
	milestone: 'Milestone',
	event: 'Event',
	timeoff: 'Time off'
};

export const KIND_ICON: Record<CalendarItem['kind'], IconName> = {
	task: 'tasks',
	milestone: 'projects',
	event: 'calendar',
	timeoff: 'people'
};
