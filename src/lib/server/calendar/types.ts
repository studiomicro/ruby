import type { CalendarItem } from '#lib/shared/calendar-items';

export type { CalendarItem };

/** What one source returns: its items for the window, and whether it hit its cap. */
export interface SourceResult {
	items: CalendarItem[];
	capped: boolean;
}
