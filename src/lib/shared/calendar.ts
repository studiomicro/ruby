import type { RecFreq } from './enums';

/**
 * RB-09 calendar arithmetic, pure and shared by the app Worker, the `ruby-jobs` Worker and the browser. Calendar dates
 * are `YYYY-MM-DD` team dates (TEAM_TIME_ZONE); instants are UTC milliseconds. Date arithmetic runs on `Date.UTC`
 * days, never on local time; wall-clock times in a zone are converted with `Intl` (DST-safe), never with a fixed
 * offset.
 */

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;

export const CAL_LIMITS = {
	titleMax: 120,
	descriptionMax: 5_000,
	locationMax: 200,
	attendeesMax: 50,
	/** An all-day event spans at most this many days (inclusive). */
	allDaySpanMaxDays: 31,
	/** A timed event lasts at most 14 days. */
	timedDurationMaxMs: 14 * DAY_MS,
	recIntervalMax: 30,
	recOccurrencesMax: 500,
	/** A series ends at most two years after its first occurrence. */
	recSpanMaxMonths: 24,
	dateMin: '2000-01-01',
	dateMax: '2100-12-31',
	/** The largest window one calendar request reads. */
	windowMaxDays: 62,
	agendaDays: 14,
	/** Rows one source returns at most; the merged list is cut at mergedMax. */
	sourceMax: 500,
	mergedMax: 1000,
	/** Instances one event expands to at most in a window. */
	expandMax: 500,
	/** Live events one user may hold (red team L1: a per-creator cap, so no one can fill the instance). */
	eventsLivePerUser: 500,
	eventsPerUserPerDay: 100,
	/** Time inputs step in 5 minutes. */
	timeStepMinutes: 5
} as const;

// ── Calendar dates ────────────────────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A real calendar date `YYYY-MM-DD` inside CAL_LIMITS' 2000–2100 range. */
export function isDate(s: string): boolean {
	const m = DATE_RE.exec(s);
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.toISOString().slice(0, 10) === s && s >= CAL_LIMITS.dateMin && s <= CAL_LIMITS.dateMax;
}

/** `HH:MM`, 24-hour. */
export const isTime = (s: string): boolean => TIME_RE.test(s);

const dayMs = (d: string) =>
	Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d: string, n: number): string => dateOf(dayMs(d) + n * DAY_MS);
/** Whole days from `a` to `b` (negative when `b` is earlier). */
export const daysBetween = (a: string, b: string): number =>
	Math.round((dayMs(b) - dayMs(a)) / DAY_MS);
/** 0 for Monday … 6 for Sunday (the week starts on Monday). */
export const weekday = (d: string): number => (new Date(dayMs(d)).getUTCDay() + 6) % 7;
export const startOfWeek = (d: string): string => addDays(d, -weekday(d));
export const minDate = (a: string, b: string) => (a < b ? a : b);
export const maxDate = (a: string, b: string) => (a > b ? a : b);
export const clampDate = (d: string) => maxDate(CAL_LIMITS.dateMin, minDate(CAL_LIMITS.dateMax, d));

const lastDayOfMonth = (year: number, month0: number) =>
	new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

/** `d` moved by `n` months onto day `day` (default: `d`'s own), clamped to the month's last day (31 Jan → 28/29 Feb). */
export function addMonths(d: string, n: number, day = Number(d.slice(8, 10))): string {
	const total = Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1 + n;
	const year = Math.floor(total / 12);
	const month0 = total - year * 12;
	return dateOf(Date.UTC(year, month0, Math.min(day, lastDayOfMonth(year, month0))));
}

export const startOfMonth = (d: string) => `${d.slice(0, 7)}-01`;

/** Every date from `from` to `to` inclusive (at most `max`). */
export function datesIn(from: string, to: string, max = 400): string[] {
	const out: string[] = [];
	for (let d = from; d <= to && out.length < max; d = addDays(d, 1)) out.push(d);
	return out;
}

// ── Time zones ───────────────────────────────────────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A cached formatter for `zone`; an unknown zone falls back to UTC (as tasks/dates.ts › todayIn does). */
function partsFormatter(zone: string): Intl.DateTimeFormat {
	let f = formatters.get(zone);
	if (!f) {
		const options: Intl.DateTimeFormatOptions = {
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		};
		try {
			f = new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone || 'UTC' });
		} catch {
			f = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
		}
		formatters.set(zone, f);
	}
	return f;
}

/** The wall clock in `zone` at instant `at`, as a UTC-day millisecond value (whole seconds). */
function wallClock(zone: string, at: number): number {
	const parts = partsFormatter(zone).formatToParts(at);
	const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
	return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
}

/** The UTC instant of wall-clock `time` (`HH:MM`) on team date `date` in `zone`; DST-safe (two-pass offset). */
export function zonedToUtc(date: string, time: string, zone: string): number {
	const wall =
		dayMs(date) + Number(time.slice(0, 2)) * 3_600_000 + Number(time.slice(3, 5)) * MINUTE_MS;
	const first = wall - (wallClock(zone, wall) - wall);
	return wall - (wallClock(zone, first) - first);
}

/** The team date and `HH:MM` of instant `at` in `zone`. */
export function utcToZoned(at: number, zone: string): { date: string; time: string } {
	const iso = new Date(wallClock(zone, Math.floor(at / 1000) * 1000)).toISOString();
	return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** The short label of `zone` shown next to times ("WIB" for Asia/Jakarta; owner decision O8). */
export function zoneLabel(zone: string): string {
	const indonesian: Record<string, string> = {
		'Asia/Jakarta': 'WIB',
		'Asia/Pontianak': 'WIB',
		'Asia/Makassar': 'WITA',
		'Asia/Jayapura': 'WIT'
	};
	if (indonesian[zone]) return indonesian[zone];
	try {
		return (
			new Intl.DateTimeFormat('en-US', { timeZone: zone || 'UTC', timeZoneName: 'short' })
				.formatToParts(0)
				.find((p) => p.type === 'timeZoneName')?.value ?? 'UTC'
		);
	} catch {
		return 'UTC';
	}
}

const dayFormat = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'UTC',
	weekday: 'short',
	day: 'numeric',
	month: 'short'
});
const dayYearFormat = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'UTC',
	weekday: 'short',
	day: 'numeric',
	month: 'short',
	year: 'numeric'
});
const monthFormat = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'UTC',
	month: 'long',
	year: 'numeric'
});

/** "Mon 2 Nov" (with the year when `withYear`) for team date `d`. */
export const formatDay = (d: string, withYear = false) =>
	(withYear ? dayYearFormat : dayFormat).format(dayMs(d)).replace(',', '');
/** "November 2026". */
export const formatMonth = (d: string) => monthFormat.format(dayMs(d));

/** "Today 09:00", "Tomorrow 14:30" or "Mon 2 Nov 2026 09:00", in `zone`, relative to `today`. */
export function describeInstant(at: number, zone: string, today: string): string {
	const { date, time } = utcToZoned(at, zone);
	const diff = daysBetween(today, date);
	const day =
		diff === 0
			? 'Today'
			: diff === 1
				? 'Tomorrow'
				: diff === -1
					? 'Yesterday'
					: formatDay(date, true);
	return `${day} ${time}`;
}

// ── Recurrence ───────────────────────────────────────────────────────────────────────────────────────────────

/** What expansion needs of an `events` row. */
export interface EventTiming {
	allDay: boolean;
	/** All-day: inclusive team dates. */
	startOn: string | null;
	endOn: string | null;
	/** Timed: UTC ms, end exclusive. */
	startAt: number | null;
	endAt: number | null;
	recFreq: RecFreq | null;
	recInterval: number;
	recUntilOn: string | null;
}

/** One instance of an event (expanded per request, never stored). */
export interface Occurrence {
	/** Team date the instance starts on (the key of an `event_exceptions` row). */
	onDate: string;
	/** Team date the instance ends on (inclusive). */
	endDate: string;
	/** UTC ms: the start (all-day: 00:00 team time) and the exclusive end. */
	startAt: number;
	endAt: number;
}

/** The start date of occurrence `k` (0 = the first) of a series that starts on `first`. */
export function occurrenceDate(first: string, freq: RecFreq, interval: number, k: number): string {
	if (freq === 'daily') return addDays(first, k * interval);
	if (freq === 'weekly') return addDays(first, 7 * k * interval);
	return addMonths(first, k * interval, Number(first.slice(8, 10)));
}

interface Shape {
	first: string;
	/** Days from an instance's start date to its end date. */
	spanDays: number;
	/** Timed: wall-clock start in the zone and duration. */
	time: string | null;
	durationMs: number;
}

function shapeOf(ev: EventTiming, zone: string): Shape {
	if (ev.allDay) {
		const first = ev.startOn as string;
		return { first, spanDays: daysBetween(first, ev.endOn as string), time: null, durationMs: 0 };
	}
	const start = utcToZoned(ev.startAt as number, zone);
	const end = utcToZoned((ev.endAt as number) - 1, zone);
	return {
		first: start.date,
		spanDays: daysBetween(start.date, end.date),
		time: start.time,
		durationMs: (ev.endAt as number) - (ev.startAt as number)
	};
}

function instance(shape: Shape, onDate: string, zone: string): Occurrence {
	if (shape.time === null) {
		const endDate = addDays(onDate, shape.spanDays);
		return {
			onDate,
			endDate,
			startAt: zonedToUtc(onDate, '00:00', zone),
			endAt: zonedToUtc(addDays(endDate, 1), '00:00', zone)
		};
	}
	const startAt = zonedToUtc(onDate, shape.time, zone);
	const endAt = startAt + shape.durationMs;
	return { onDate, endDate: utcToZoned(endAt - 1, zone).date, startAt, endAt };
}

/** Occurrence start dates of `ev` in order (one for a single event), at most CAL_LIMITS.recOccurrencesMax. */
function* occurrenceDates(ev: EventTiming, shape: Shape, fromK = 0): Generator<string> {
	if (!ev.recFreq || !ev.recUntilOn) {
		if (fromK === 0) yield shape.first;
		return;
	}
	for (let k = fromK; k < CAL_LIMITS.recOccurrencesMax; k++) {
		const d = occurrenceDate(shape.first, ev.recFreq, ev.recInterval, k);
		if (d > ev.recUntilOn) return;
		yield d;
	}
}

/**
 * The instances of `ev` that touch team dates `from`..`to` (inclusive), skipping the start dates in `exceptions`,
 * at most `max`. Daily and weekly series jump straight to the window instead of walking from the first occurrence.
 */
export function expandEvent(
	ev: EventTiming,
	from: string,
	to: string,
	exceptions: ReadonlySet<string>,
	zone: string,
	max: number = CAL_LIMITS.expandMax
): Occurrence[] {
	const shape = shapeOf(ev, zone);
	const step =
		ev.recFreq === 'daily' ? ev.recInterval : ev.recFreq === 'weekly' ? 7 * ev.recInterval : 0;
	const fromK =
		step > 0
			? Math.max(0, Math.floor((daysBetween(shape.first, from) - shape.spanDays - 1) / step))
			: 0;
	const out: Occurrence[] = [];
	for (const d of occurrenceDates(ev, shape, fromK)) {
		if (d > to || out.length >= max) break;
		if (addDays(d, shape.spanDays) < from || exceptions.has(d)) continue;
		out.push(instance(shape, d, zone));
	}
	return out;
}

/** The first instance of `ev` (not in `exceptions`) that `accept` takes, in order; null when none remains. */
export function findOccurrence(
	ev: EventTiming,
	exceptions: ReadonlySet<string>,
	zone: string,
	accept: (o: Occurrence) => boolean
): Occurrence | null {
	const shape = shapeOf(ev, zone);
	for (const d of occurrenceDates(ev, shape)) {
		if (exceptions.has(d)) continue;
		const o = instance(shape, d, zone);
		if (accept(o)) return o;
	}
	return null;
}

/** The instance of `ev` starting on `onDate`, or null when no occurrence starts that day. */
export function occurrenceOn(ev: EventTiming, onDate: string, zone: string): Occurrence | null {
	const shape = shapeOf(ev, zone);
	for (const d of occurrenceDates(ev, shape)) {
		if (d > onDate) break;
		if (d === onDate) return instance(shape, d, zone);
	}
	return null;
}

/** The first and last team dates `ev` (or its whole series) touches: the `first_on`/`last_on` columns. */
export function eventSpan(ev: EventTiming, zone: string): { firstOn: string; lastOn: string } {
	const shape = shapeOf(ev, zone);
	let last = shape.first;
	for (const d of occurrenceDates(ev, shape)) last = d;
	return { firstOn: shape.first, lastOn: addDays(last, shape.spanDays) };
}

/** How many occurrences a series from `first` to `until` has (stops counting past the cap + 1). */
export function countOccurrences(
	first: string,
	freq: RecFreq,
	interval: number,
	until: string
): number {
	let n = 0;
	while (n <= CAL_LIMITS.recOccurrencesMax && occurrenceDate(first, freq, interval, n) <= until)
		n++;
	return n;
}

// ── Calendar views and filters ───────────────────────────────────────────────────────────────────────────────

export const CALENDAR_VIEWS = ['month', 'week', 'agenda'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export const CALENDAR_SOURCES = ['tasks', 'milestones', 'events', 'timeoff'] as const;
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];

export const TASK_SCOPES = ['mine', 'all', 'project'] as const;
export type TaskScope = (typeof TASK_SCOPES)[number];

export interface CalendarFilter {
	/** Null: no `view` given; the page renders the month and the agenda and CSS picks one per width. */
	view: CalendarView | null;
	/** The anchor team date. */
	date: string;
	show: CalendarSource[];
	tasks: TaskScope;
	/** A project key (upper case) as given; the loader checks that the project exists. */
	project: string | null;
	done: boolean;
	/** Only events I created or attend. */
	mine: boolean;
}

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/**
 * The calendar's URL state. Unknown keys and invalid values are dropped: a bad `view` means none, a bad `date` means
 * `today`, a date outside 2000–2100 is clamped, `show` keeps the known sources among `available` (all of them when
 * none is left), and `tasks=project` without a project key falls back to `mine`.
 */
export function parseCalendarFilter(
	params: URLSearchParams,
	today: string,
	available: readonly CalendarSource[]
): CalendarFilter {
	const rawView = params.get('view');
	const view = (CALENDAR_VIEWS as readonly string[]).includes(rawView ?? '')
		? (rawView as CalendarView)
		: null;
	const rawDate = params.get('date') ?? '';
	let date = today;
	if (DATE_RE.test(rawDate)) {
		const clamped = clampDate(rawDate);
		if (isDate(clamped)) date = clamped;
	}
	// `show=tasks,events` (a link) or `show=tasks&show=events` (the filter form's checkboxes).
	const shown = params
		.getAll('show')
		.flatMap((v) => v.split(','))
		.filter((s): s is CalendarSource => (available as readonly string[]).includes(s));
	const show = shown.length > 0 ? [...new Set(shown)] : [...available];
	const rawProject = (params.get('project') ?? '').toUpperCase();
	const project = PROJECT_KEY_RE.test(rawProject) ? rawProject : null;
	const rawTasks = params.get('tasks');
	let tasks: TaskScope = (TASK_SCOPES as readonly string[]).includes(rawTasks ?? '')
		? (rawTasks as TaskScope)
		: 'mine';
	if (tasks === 'project' && !project) tasks = 'mine';
	return {
		view,
		date,
		show,
		tasks,
		project,
		done: params.get('done') === '1',
		mine: params.get('mine') === '1'
	};
}

/** The URL of `filter` with `changes` applied; defaults are left out, so links stay short. */
export function calendarHref(
	filter: CalendarFilter,
	changes: Partial<CalendarFilter> = {},
	available: readonly CalendarSource[] = CALENDAR_SOURCES
): string {
	const f = { ...filter, ...changes };
	const p = new URLSearchParams();
	if (f.view) p.set('view', f.view);
	p.set('date', f.date);
	if (f.show.length > 0 && f.show.length < available.length) p.set('show', f.show.join(','));
	if (f.tasks !== 'mine') p.set('tasks', f.tasks);
	if (f.project) p.set('project', f.project);
	if (f.done) p.set('done', '1');
	if (f.mine) p.set('mine', '1');
	return `/calendar?${p.toString()}`;
}

export interface DateRange {
	from: string;
	to: string;
}

/** The 6 × 7 month grid around `anchor`: Monday on or before the 1st, 42 days. */
export function monthGrid(anchor: string): DateRange {
	const from = startOfWeek(startOfMonth(anchor));
	return { from, to: addDays(from, 41) };
}

/** Monday to Sunday of `anchor`'s week. */
export function weekRange(anchor: string): DateRange {
	const from = startOfWeek(anchor);
	return { from, to: addDays(from, 6) };
}

/** The agenda's 14 days from `anchor`. */
export const agendaRange = (anchor: string): DateRange => ({
	from: anchor,
	to: addDays(anchor, CAL_LIMITS.agendaDays - 1)
});

/** The ranges a view renders (no `view`: month and agenda) and the one window the loader reads, at most 62 days. */
export function viewRanges(
	view: CalendarView | null,
	anchor: string
): { grid: DateRange | null; agenda: DateRange | null; window: DateRange } {
	const grid = view === 'week' ? weekRange(anchor) : view === 'agenda' ? null : monthGrid(anchor);
	const agenda = view === null || view === 'agenda' ? agendaRange(anchor) : null;
	const from = minDate(grid?.from ?? anchor, agenda?.from ?? anchor);
	const to = maxDate(grid?.to ?? anchor, agenda?.to ?? anchor);
	return {
		grid,
		agenda,
		window: { from, to: minDate(to, addDays(from, CAL_LIMITS.windowMaxDays - 1)) }
	};
}

/** The anchor one step before or after `anchor` in `view` (month by month, week by week, 14 days for the agenda). */
export function stepAnchor(view: CalendarView | null, anchor: string, dir: 1 | -1): string {
	if (view === 'week') return clampDate(addDays(anchor, 7 * dir));
	if (view === 'agenda') return clampDate(addDays(anchor, CAL_LIMITS.agendaDays * dir));
	return clampDate(addMonths(startOfMonth(anchor), dir, 1));
}

// ── Reminders ────────────────────────────────────────────────────────────────────────────────────────────────

/** A task's relative reminders count back from 09:00 team time on its due date (owner decision O6). */
export const TASK_ANCHOR_TIME = '09:00';

export const TASK_REMINDER_PRESETS = [
	{ offset: 0, label: 'On the due date (09:00)' },
	{ offset: 1440, label: '1 day before' },
	{ offset: 2880, label: '2 days before' },
	{ offset: 10080, label: '1 week before' }
] as const;

export const EVENT_REMINDER_PRESETS = [
	{ offset: 0, label: 'At start' },
	{ offset: 10, label: '10 minutes before' },
	{ offset: 30, label: '30 minutes before' },
	{ offset: 60, label: '1 hour before' },
	{ offset: 1440, label: '1 day before' },
	{ offset: 10080, label: '1 week before' }
] as const;

export const REMINDER_LIMITS = {
	perTarget: 10,
	pendingPerUser: 200,
	/** Reminders one user may create in 24 hours, deleted ones included (red team L2). */
	createsPerUserPerDay: 300,
	/** A new reminder fires at least this far in the future. */
	minLeadMs: 60_000,
	/** An absolute reminder is at most two years ahead. */
	maxAheadMs: 731 * DAY_MS,
	/** A due reminder more than this late closes as `missed` (owner decision O7). */
	lateMaxMs: DAY_MS,
	titleMax: 120,
	summaryMax: 140
} as const;

/** The label of a reminder offset, e.g. "1 day before". */
export function offsetLabel(kind: 'task' | 'event', offset: number): string {
	const presets: readonly { offset: number; label: string }[] =
		kind === 'task' ? TASK_REMINDER_PRESETS : EVENT_REMINDER_PRESETS;
	return presets.find((p) => p.offset === offset)?.label ?? `${offset} minutes before`;
}
