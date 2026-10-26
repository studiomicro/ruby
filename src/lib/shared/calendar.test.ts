import { describe, expect, it } from 'vitest';
import {
	addMonths,
	CAL_LIMITS,
	calendarHref,
	countOccurrences,
	daysBetween,
	describeInstant,
	eventSpan,
	expandEvent,
	findOccurrence,
	isDate,
	monthGrid,
	occurrenceOn,
	parseCalendarFilter,
	stepAnchor,
	utcToZoned,
	viewRanges,
	weekRange,
	zonedToUtc,
	zoneLabel,
	type EventTiming
} from './calendar';
import { groupByDay, type CalendarItem } from './calendar-items';

const JKT = 'Asia/Jakarta';
const NY = 'America/New_York';
const iso = (ms: number) => new Date(ms).toISOString();
const ALL = ['tasks', 'events'] as const;

describe('zonedToUtc / utcToZoned', () => {
	it('Jakarta is UTC+7 all year (criterion 10)', () => {
		expect(iso(zonedToUtc('2026-11-02', '14:00', JKT))).toBe('2026-11-02T07:00:00.000Z');
		expect(iso(zonedToUtc('2026-11-05', '09:00', JKT))).toBe('2026-11-05T02:00:00.000Z');
		expect(utcToZoned(Date.parse('2026-11-02T07:00:00Z'), JKT)).toEqual({
			date: '2026-11-02',
			time: '14:00'
		});
	});
	it('a zone with DST: New York in summer and winter, and across the switch days', () => {
		expect(iso(zonedToUtc('2026-07-01', '09:00', NY))).toBe('2026-07-01T13:00:00.000Z');
		expect(iso(zonedToUtc('2026-12-01', '09:00', NY))).toBe('2026-12-01T14:00:00.000Z');
		// 2026-03-08 02:00 → 03:00 (spring forward); 2026-11-01 02:00 → 01:00 (fall back).
		expect(iso(zonedToUtc('2026-03-08', '12:00', NY))).toBe('2026-03-08T16:00:00.000Z');
		expect(iso(zonedToUtc('2026-11-01', '12:00', NY))).toBe('2026-11-01T17:00:00.000Z');
		expect(utcToZoned(Date.parse('2026-03-08T16:00:00Z'), NY).time).toBe('12:00');
	});
	it('day boundaries: midnight in the zone is the previous UTC day', () => {
		expect(iso(zonedToUtc('2026-01-01', '00:00', JKT))).toBe('2025-12-31T17:00:00.000Z');
		expect(utcToZoned(Date.parse('2025-12-31T17:00:00Z'), JKT).date).toBe('2026-01-01');
		expect(utcToZoned(Date.parse('2025-12-31T16:59:00Z'), JKT).date).toBe('2025-12-31');
	});
	it('an unknown zone falls back to UTC', () => {
		expect(iso(zonedToUtc('2026-11-02', '14:00', 'Nowhere/Never'))).toBe(
			'2026-11-02T14:00:00.000Z'
		);
	});
	it('labels Jakarta WIB', () => {
		expect(zoneLabel(JKT)).toBe('WIB');
		expect(zoneLabel('UTC')).toBe('UTC');
	});
	it('describes instants relative to the team day', () => {
		const at = zonedToUtc('2026-11-03', '09:00', JKT);
		expect(describeInstant(at, JKT, '2026-11-03')).toBe('Today 09:00');
		expect(describeInstant(at, JKT, '2026-11-02')).toBe('Tomorrow 09:00');
		expect(describeInstant(at, JKT, '2026-10-01')).toBe('Tue 3 Nov 2026 09:00');
	});
});

describe('dates', () => {
	it('validates real dates inside 2000–2100 only', () => {
		expect(isDate('2026-02-28')).toBe(true);
		expect(isDate('2026-02-29')).toBe(false);
		expect(isDate('2028-02-29')).toBe(true);
		expect(isDate('1999-12-31')).toBe(false);
		expect(isDate('2101-01-01')).toBe(false);
		expect(isDate('2026-1-1')).toBe(false);
	});
	it('months clamp to the last day (31 Jan → 28/29 Feb → 31 Mar)', () => {
		expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
		expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
		expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
		expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
	});
	it('the month grid starts on a Monday and has 42 days; leap February', () => {
		const g = monthGrid('2028-02-10');
		expect(g.from).toBe('2028-01-31'); // Monday
		expect(daysBetween(g.from, g.to)).toBe(41);
		expect(monthGrid('2026-11-15').from).toBe('2026-10-26');
	});
	it('weeks run Monday to Sunday', () => {
		expect(weekRange('2026-11-01')).toEqual({ from: '2026-10-26', to: '2026-11-01' }); // a Sunday
		expect(weekRange('2026-11-02')).toEqual({ from: '2026-11-02', to: '2026-11-08' });
	});
	it('steps by view', () => {
		expect(stepAnchor('month', '2026-01-31', 1)).toBe('2026-02-01');
		expect(stepAnchor('week', '2026-11-02', -1)).toBe('2026-10-26');
		expect(stepAnchor('agenda', '2026-11-02', 1)).toBe('2026-11-16');
		expect(stepAnchor('month', '2100-12-15', 1)).toBe('2100-12-31');
	});
});

describe('parseCalendarFilter', () => {
	const today = '2026-11-02';
	const parse = (q: string) => parseCalendarFilter(new URLSearchParams(q), today, ALL);
	it('defaults: no view, today, every available source, my tasks', () => {
		expect(parse('')).toEqual({
			view: null,
			date: today,
			show: ['tasks', 'events'],
			tasks: 'mine',
			project: null,
			done: false,
			mine: false
		});
	});
	it('drops invalid values and unknown keys (criterion 7)', () => {
		const f = parse('view=year&date=2026-02-30&show=nope,timeoff&tasks=x&project=bad-key&evil=1');
		expect(f).toMatchObject({ view: null, date: today, show: ['tasks', 'events'], tasks: 'mine' });
		expect(f.project).toBeNull();
	});
	it('clamps dates outside 2000–2100', () => {
		expect(parse('date=1990-05-05').date).toBe('2000-01-01');
		expect(parse('date=2200-05-05').date).toBe('2100-12-31');
	});
	it('show as a list or repeated, timeoff ignored while unavailable', () => {
		expect(parse('show=events').show).toEqual(['events']);
		expect(parse('show=events&show=tasks').show).toEqual(['events', 'tasks']);
		expect(parse('show=timeoff').show).toEqual(['tasks', 'events']);
	});
	it('tasks=project needs a project key, else mine', () => {
		expect(parse('tasks=project').tasks).toBe('mine');
		expect(parse('tasks=project&project=ops')).toMatchObject({ tasks: 'project', project: 'OPS' });
		expect(parse('tasks=all&done=1&mine=1')).toMatchObject({
			tasks: 'all',
			done: true,
			mine: true
		});
	});
	it('round-trips through calendarHref', () => {
		const f = parse('view=week&date=2026-11-04&tasks=all&project=OPS&done=1&show=tasks');
		const back = parseCalendarFilter(
			new URL(calendarHref(f, {}, ALL), 'http://x').searchParams,
			today,
			ALL
		);
		expect(back).toEqual(f);
	});
	it('one window per request, at most 62 days', () => {
		for (const view of ['month', 'week', 'agenda', null] as const)
			for (const d of ['2026-01-31', '2026-02-01', '2026-12-31']) {
				const { window } = viewRanges(view, d);
				expect(daysBetween(window.from, window.to) + 1).toBeLessThanOrEqual(
					CAL_LIMITS.windowMaxDays
				);
			}
		const auto = viewRanges(null, '2026-11-30');
		expect(auto.grid).toEqual(monthGrid('2026-11-30'));
		expect(auto.agenda).toEqual({ from: '2026-11-30', to: '2026-12-13' });
	});
});

const timed = (start: string, end: string, extra: Partial<EventTiming> = {}): EventTiming => ({
	allDay: false,
	startOn: null,
	endOn: null,
	startAt: Date.parse(start),
	endAt: Date.parse(end),
	recFreq: null,
	recInterval: 1,
	recUntilOn: null,
	...extra
});
const allDay = (startOn: string, endOn: string, extra: Partial<EventTiming> = {}): EventTiming => ({
	allDay: true,
	startOn,
	endOn,
	startAt: null,
	endAt: null,
	recFreq: null,
	recInterval: 1,
	recUntilOn: null,
	...extra
});
const none = new Set<string>();

describe('expandEvent', () => {
	it('an all-day event over 3 days touches each of them and not the 4th', () => {
		const ev = allDay('2026-11-02', '2026-11-04');
		const o = expandEvent(ev, '2026-11-01', '2026-11-30', none, JKT);
		expect(o).toHaveLength(1);
		expect(o[0]).toMatchObject({ onDate: '2026-11-02', endDate: '2026-11-04' });
		const days = groupByDay(
			o.map((x) => ({ startOn: x.onDate, endOn: x.endDate }) as CalendarItem),
			{ from: '2026-11-01', to: '2026-11-06' }
		);
		expect(days.filter((d) => d.items.length > 0).map((d) => d.date)).toEqual([
			'2026-11-02',
			'2026-11-03',
			'2026-11-04'
		]);
	});
	it('weekly every 2 weeks until a date keeps the wall-clock time', () => {
		const ev = timed('2026-11-02T07:00:00Z', '2026-11-02T08:30:00Z', {
			recFreq: 'weekly',
			recInterval: 2,
			recUntilOn: '2026-12-14'
		});
		const o = expandEvent(ev, '2026-11-01', '2026-12-31', none, JKT);
		expect(o.map((x) => x.onDate)).toEqual([
			'2026-11-02',
			'2026-11-16',
			'2026-11-30',
			'2026-12-14'
		]);
		expect(o.every((x) => x.endAt - x.startAt === 90 * 60_000)).toBe(true);
		expect(utcToZoned(o[3]!.startAt, JKT).time).toBe('14:00');
	});
	it('daily ×10 and only inside the window', () => {
		const ev = allDay('2026-11-01', '2026-11-01', {
			recFreq: 'daily',
			recUntilOn: '2026-11-10'
		});
		expect(countOccurrences('2026-11-01', 'daily', 1, '2026-11-10')).toBe(10);
		expect(expandEvent(ev, '2026-11-05', '2026-11-07', none, JKT).map((o) => o.onDate)).toEqual([
			'2026-11-05',
			'2026-11-06',
			'2026-11-07'
		]);
		expect(expandEvent(ev, '2026-11-11', '2026-11-30', none, JKT)).toEqual([]);
	});
	it('monthly on the 31st clamps to short months', () => {
		const ev = allDay('2026-01-31', '2026-01-31', { recFreq: 'monthly', recUntilOn: '2026-05-31' });
		expect(expandEvent(ev, '2026-01-01', '2026-06-30', none, JKT).map((o) => o.onDate)).toEqual([
			'2026-01-31',
			'2026-02-28',
			'2026-03-31',
			'2026-04-30',
			'2026-05-31'
		]);
	});
	it('a removed occurrence disappears and the others stay', () => {
		const ev = allDay('2026-11-02', '2026-11-02', { recFreq: 'weekly', recUntilOn: '2026-11-30' });
		const o = expandEvent(ev, '2026-11-01', '2026-11-30', new Set(['2026-11-09']), JKT);
		expect(o.map((x) => x.onDate)).toEqual([
			'2026-11-02',
			'2026-11-16',
			'2026-11-23',
			'2026-11-30'
		]);
	});
	it('a multi-day occurrence starting before the window still shows', () => {
		const ev = allDay('2026-10-30', '2026-11-02', { recFreq: 'weekly', recUntilOn: '2026-11-30' });
		expect(expandEvent(ev, '2026-11-01', '2026-11-03', none, JKT).map((o) => o.onDate)).toEqual([
			'2026-10-30'
		]);
	});
	it('is capped', () => {
		const ev = allDay('2026-01-01', '2026-01-01', { recFreq: 'daily', recUntilOn: '2027-01-01' });
		expect(expandEvent(ev, '2026-01-01', '2026-03-01', none, JKT, 5)).toHaveLength(5);
	});
	it('span, occurrenceOn and findOccurrence agree', () => {
		const ev = allDay('2026-11-02', '2026-11-03', { recFreq: 'weekly', recUntilOn: '2026-11-16' });
		expect(eventSpan(ev, JKT)).toEqual({ firstOn: '2026-11-02', lastOn: '2026-11-17' });
		expect(occurrenceOn(ev, '2026-11-09', JKT)?.onDate).toBe('2026-11-09');
		expect(occurrenceOn(ev, '2026-11-10', JKT)).toBeNull();
		const after = zonedToUtc('2026-11-09', '00:00', JKT);
		expect(findOccurrence(ev, none, JKT, (o) => o.startAt > after)?.onDate).toBe('2026-11-16');
		expect(findOccurrence(ev, new Set(['2026-11-16']), JKT, (o) => o.startAt > after)).toBeNull();
	});
});
