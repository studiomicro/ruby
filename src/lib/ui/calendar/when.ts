import { describeInstant, utcToZoned } from '#lib/shared/calendar';
import type { ReminderOutcome } from '#lib/shared/enums';

/** Times on calendar pages are team-zone wall clock with the zone's label (owner decision O8): "Tomorrow 09:00 WIB". */
export const whenText = (at: number, zone: string, label: string, today: string) =>
	`${describeInstant(at, zone, today)} ${label}`;

/** "14:00–15:30" in `zone`. */
export function timeRange(start: number, end: number, zone: string): string {
	return `${utcToZoned(start, zone).time}–${utcToZoned(end, zone).time}`;
}

export const OUTCOME_TEXT: Record<ReminderOutcome, string> = {
	sent: 'Sent',
	missed: 'Missed while the system was unavailable',
	canceled: 'Canceled',
	dead: 'Could not be delivered'
};
