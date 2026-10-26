import { daysBetween, formatDay, REMINDER_LIMITS, utcToZoned } from '../../shared/calendar';
import { cleanText } from '../../shared/text';

/**
 * The plain-text line a fired reminder leaves in the inbox (and the e-mail subject), snapshotted at fire time:
 * `OPS-12 Fix login is due tomorrow`, `Design review starts in 1 hour`, or a personal reminder's title. Never Markdown,
 * control characters stripped, at most REMINDER_LIMITS.summaryMax characters.
 */

const clip = (s: string) => cleanText(s, REMINDER_LIMITS.summaryMax);
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

export function taskSummary(
	task: { ref: string; title: string; dueOn: string | null },
	now: number,
	zone: string
): string {
	const name = `${task.ref} ${task.title}`;
	if (!task.dueOn) return clip(name);
	const days = daysBetween(utcToZoned(now, zone).date, task.dueOn);
	const phrase =
		days === 0
			? 'is due today'
			: days === 1
				? 'is due tomorrow'
				: days > 1
					? `is due in ${plural(days, 'day')}`
					: `was due ${formatDay(task.dueOn, true)}`;
	// The phrase survives a long title: the title is cut first.
	return `${cleanText(name, REMINDER_LIMITS.summaryMax - phrase.length - 1)} ${phrase}`;
}

export function eventSummary(
	event: { title: string; allDay: boolean },
	occurrence: { onDate: string; startAt: number },
	now: number,
	zone: string
): string {
	let phrase: string;
	if (event.allDay) {
		const days = daysBetween(utcToZoned(now, zone).date, occurrence.onDate);
		phrase =
			days === 0
				? 'is today'
				: days === 1
					? 'is tomorrow'
					: `is on ${formatDay(occurrence.onDate, true)}`;
	} else {
		const minutes = Math.round((occurrence.startAt - now) / 60_000);
		phrase =
			minutes <= 0
				? 'starts now'
				: minutes < 60
					? `starts in ${plural(minutes, 'minute')}`
					: minutes < 1440
						? `starts in ${plural(Math.round(minutes / 60), 'hour')}`
						: `starts in ${plural(Math.round(minutes / 1440), 'day')}`;
	}
	return `${cleanText(event.title, REMINDER_LIMITS.summaryMax - phrase.length - 1)} ${phrase}`;
}

export const personalSummary = (title: string) => clip(title) || 'Reminder';
