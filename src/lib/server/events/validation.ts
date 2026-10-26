import {
	addMonths,
	CAL_LIMITS,
	countOccurrences,
	daysBetween,
	eventSpan,
	isDate,
	isTime,
	occurrenceDate,
	zonedToUtc
} from '#lib/shared/calendar';
import {
	EVENT_VISIBILITIES,
	REC_FREQS,
	type EventVisibility,
	type RecFreq
} from '#lib/shared/enums';
import { cleanBody, cleanLine, isUuid } from '../tasks/validation';

/**
 * The event form (RB-09 PRD › Events), parsed on the server; the browser's `maxlength`/`required` only mirror it.
 * Times are team-zone wall clock (`date` + `time` inputs) converted to UTC with `zonedToUtc`; the client's clock and
 * zone are never used.
 */

export const EVENT_FIELDS = [
	'title',
	'description',
	'location',
	'start',
	'end',
	'projectId',
	'visibility',
	'attendees',
	'repeat'
] as const;
export type EventField = (typeof EVENT_FIELDS)[number];
export type EventErrors = Partial<Record<EventField | 'form', string>>;

export interface EventInput {
	title: string;
	description: string;
	location: string;
	allDay: boolean;
	startOn: string | null;
	endOn: string | null;
	startAt: number | null;
	endAt: number | null;
	projectId: string | null;
	visibility: EventVisibility;
	attendeeIds: string[];
	recFreq: RecFreq | null;
	recInterval: number;
	recUntilOn: string | null;
	firstOn: string;
	lastOn: string;
}

/** What the form sent, echoed back on a refusal (strings only, capped). */
export interface EventFormValues {
	title: string;
	description: string;
	location: string;
	allDay: boolean;
	startDate: string;
	startTime: string;
	endDate: string;
	endTime: string;
	projectId: string;
	visibility: string;
	attendees: string[];
	repeat: string;
	interval: string;
	ends: string;
	until: string;
	count: string;
}

export const EVENT_MESSAGES = {
	titleRequired: 'Enter a title.',
	titleLong: `Use at most ${CAL_LIMITS.titleMax} characters.`,
	descriptionLong: `Use at most ${CAL_LIMITS.descriptionMax} characters.`,
	locationLong: `Use at most ${CAL_LIMITS.locationMax} characters.`,
	date: 'Enter a date between 2000-01-01 and 2100-12-31.',
	time: 'Enter a time in 5-minute steps.',
	endBeforeStart: 'The end must be after the start.',
	allDayTooLong: `An all-day event can span at most ${CAL_LIMITS.allDaySpanMaxDays} days.`,
	timedTooLong: 'An event can last at most 14 days.',
	project: 'Choose an active project, or none.',
	visibility: 'Choose who can see the event.',
	attendeesTooMany: `Choose at most ${CAL_LIMITS.attendeesMax} attendees.`,
	attendee: 'Every attendee must be an active user.',
	interval: `Repeat every 1 to ${CAL_LIMITS.recIntervalMax}.`,
	endsRequired: 'A repeating event needs an end: a date or a number of times.',
	untilBeforeStart: 'The series must end on or after its first day.',
	seriesTooLong: `A series can run at most 2 years and ${CAL_LIMITS.recOccurrencesMax} times.`,
	count: `Enter a number from 1 to ${CAL_LIMITS.recOccurrencesMax}.`,
	conflict: 'This event changed meanwhile. Reload to see the latest; your text is kept below.',
	notAllowed: 'Only the event’s creator or an admin can change it.',
	liveLimit: `You can have at most ${CAL_LIMITS.eventsLivePerUser} events. Delete old ones first.`,
	dailyLimit: `You can create at most ${CAL_LIMITS.eventsPerUserPerDay} events a day.`,
	notFound: 'Event not found.'
} as const;

const field = (form: FormData, name: string) => {
	const v = form.get(name);
	return typeof v === 'string' ? v : '';
};

export function formValues(form: FormData): EventFormValues {
	const s = (name: string, max = 40) => field(form, name).slice(0, max);
	return {
		title: s('title', CAL_LIMITS.titleMax * 4),
		description: s('description', CAL_LIMITS.descriptionMax + 1),
		location: s('location', CAL_LIMITS.locationMax * 4),
		allDay: field(form, 'allDay') === 'on',
		startDate: s('startDate'),
		startTime: s('startTime'),
		endDate: s('endDate'),
		endTime: s('endTime'),
		projectId: s('projectId'),
		visibility: s('visibility'),
		attendees: form
			.getAll('attendees')
			.filter((v): v is string => typeof v === 'string')
			.slice(0, CAL_LIMITS.attendeesMax + 1)
			.map((v) => v.slice(0, 40)),
		repeat: s('repeat'),
		interval: s('interval'),
		ends: s('ends'),
		until: s('until'),
		count: s('count')
	};
}

const onFiveMinutes = (t: string) =>
	isTime(t) && Number(t.slice(3, 5)) % CAL_LIMITS.timeStepMinutes === 0;

/**
 * Parses an event form. Attendee ids are checked for shape here; that they are active users, and that the project
 * is live and active, is checked by the repository in the write itself.
 */
export function parseEventForm(
	form: FormData,
	zone: string
): { ok: true; value: EventInput } | { ok: false; errors: EventErrors; values: EventFormValues } {
	const values = formValues(form);
	const errors: EventErrors = {};

	const title = cleanLine(field(form, 'title'), CAL_LIMITS.titleMax);
	if (title.tooLong) errors.title = EVENT_MESSAGES.titleLong;
	else if (!title.value) errors.title = EVENT_MESSAGES.titleRequired;
	const description = cleanBody(field(form, 'description').slice(0, CAL_LIMITS.descriptionMax * 2));
	if (Array.from(description).length > CAL_LIMITS.descriptionMax)
		errors.description = EVENT_MESSAGES.descriptionLong;
	const location = cleanLine(field(form, 'location'), CAL_LIMITS.locationMax);
	if (location.tooLong) errors.location = EVENT_MESSAGES.locationLong;

	const allDay = values.allDay;
	let startOn: string | null = null;
	let endOn: string | null = null;
	let startAt: number | null = null;
	let endAt: number | null = null;
	const endDateRaw = values.endDate || values.startDate;
	if (!isDate(values.startDate)) errors.start = EVENT_MESSAGES.date;
	else if (!isDate(endDateRaw)) errors.end = EVENT_MESSAGES.date;
	else if (allDay) {
		startOn = values.startDate;
		endOn = endDateRaw;
		if (endOn < startOn) errors.end = EVENT_MESSAGES.endBeforeStart;
		else if (daysBetween(startOn, endOn) + 1 > CAL_LIMITS.allDaySpanMaxDays)
			errors.end = EVENT_MESSAGES.allDayTooLong;
	} else if (!onFiveMinutes(values.startTime)) errors.start = EVENT_MESSAGES.time;
	else if (!onFiveMinutes(values.endTime)) errors.end = EVENT_MESSAGES.time;
	else {
		startAt = zonedToUtc(values.startDate, values.startTime, zone);
		endAt = zonedToUtc(endDateRaw, values.endTime, zone);
		if (endAt <= startAt) errors.end = EVENT_MESSAGES.endBeforeStart;
		else if (endAt - startAt > CAL_LIMITS.timedDurationMaxMs)
			errors.end = EVENT_MESSAGES.timedTooLong;
	}

	const projectId = values.projectId === '' ? null : values.projectId.toLowerCase();
	if (projectId !== null && !isUuid(projectId)) errors.projectId = EVENT_MESSAGES.project;

	const visibility = (values.visibility || 'team') as EventVisibility;
	if (!EVENT_VISIBILITIES.includes(visibility)) errors.visibility = EVENT_MESSAGES.visibility;

	const attendeeIds = [...new Set(values.attendees.map((a) => a.toLowerCase()))];
	if (attendeeIds.length > CAL_LIMITS.attendeesMax)
		errors.attendees = EVENT_MESSAGES.attendeesTooMany;
	else if (!attendeeIds.every(isUuid)) errors.attendees = EVENT_MESSAGES.attendee;

	let recFreq: RecFreq | null = null;
	let recInterval = 1;
	let recUntilOn: string | null = null;
	if (values.repeat && values.repeat !== 'none') {
		if (!(REC_FREQS as readonly string[]).includes(values.repeat))
			errors.repeat = EVENT_MESSAGES.endsRequired;
		else recFreq = values.repeat as RecFreq;
		recInterval = values.interval === '' ? 1 : Number(values.interval);
		if (
			!/^\d{1,2}$/.test(values.interval || '1') ||
			recInterval < 1 ||
			recInterval > CAL_LIMITS.recIntervalMax
		)
			errors.repeat = EVENT_MESSAGES.interval;
		const first = startOn ?? (isDate(values.startDate) ? values.startDate : null);
		if (recFreq && first && !errors.repeat) {
			if (values.ends === 'count') {
				const count = Number(values.count);
				if (!/^\d{1,3}$/.test(values.count) || count < 1 || count > CAL_LIMITS.recOccurrencesMax)
					errors.repeat = EVENT_MESSAGES.count;
				else recUntilOn = occurrenceDate(first, recFreq, recInterval, count - 1);
			} else if (values.ends === 'until') {
				if (!isDate(values.until)) errors.repeat = EVENT_MESSAGES.date;
				else recUntilOn = values.until;
			} else errors.repeat = EVENT_MESSAGES.endsRequired;
			if (recUntilOn && !errors.repeat) {
				if (recUntilOn < first) errors.repeat = EVENT_MESSAGES.untilBeforeStart;
				else if (
					recUntilOn > addMonths(first, CAL_LIMITS.recSpanMaxMonths) ||
					countOccurrences(first, recFreq, recInterval, recUntilOn) > CAL_LIMITS.recOccurrencesMax
				)
					errors.repeat = EVENT_MESSAGES.seriesTooLong;
			}
		}
	}

	if (Object.keys(errors).length > 0 || (startOn === null && startAt === null))
		return { ok: false, errors, values };
	const value: Omit<EventInput, 'firstOn' | 'lastOn'> = {
		title: title.value,
		description,
		location: location.value,
		allDay,
		startOn,
		endOn,
		startAt,
		endAt,
		projectId,
		visibility,
		attendeeIds,
		recFreq,
		recInterval: recFreq ? recInterval : 1,
		recUntilOn: recFreq ? recUntilOn : null
	};
	const span = eventSpan(value, zone);
	if (span.lastOn > CAL_LIMITS.dateMax)
		return { ok: false, errors: { end: EVENT_MESSAGES.date }, values };
	return { ok: true, value: { ...value, firstOn: span.firstOn, lastOn: span.lastOn } };
}

/** The form values of a stored event (the edit form's initial state), in team-zone wall clock. */
export function valuesOfEvent(
	ev: Omit<EventInput, 'firstOn' | 'lastOn'>,
	toZoned: (at: number) => { date: string; time: string }
): EventFormValues {
	const start = ev.startAt !== null ? toZoned(ev.startAt) : null;
	const end = ev.endAt !== null ? toZoned(ev.endAt) : null;
	return {
		title: ev.title,
		description: ev.description,
		location: ev.location,
		allDay: ev.allDay,
		startDate: ev.startOn ?? start?.date ?? '',
		startTime: start?.time ?? '09:00',
		endDate: ev.endOn ?? end?.date ?? '',
		endTime: end?.time ?? '10:00',
		projectId: ev.projectId ?? '',
		visibility: ev.visibility,
		attendees: ev.attendeeIds,
		repeat: ev.recFreq ?? 'none',
		interval: String(ev.recInterval),
		ends: ev.recFreq ? 'until' : '',
		until: ev.recUntilOn ?? '',
		count: ''
	};
}
