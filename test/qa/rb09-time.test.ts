import { describe, expect, it } from 'vitest';
import {
	expandEvent,
	monthGrid,
	startOfWeek,
	viewRanges,
	weekRange,
	zonedToUtc,
	type EventTiming
} from '#lib/shared/calendar';

/** RB-09 QA: Asia/Jakarta (UTC+7, no DST) time maths, expected values worked out by hand. */
const Z = 'Asia/Jakarta';
const base = { recFreq: null, recInterval: 1, recUntilOn: null } as const;

describe('RB-09 QA time maths (Asia/Jakarta)', () => {
	it('timed event 14:00 WIB is 07:00Z', () => {
		expect(new Date(zonedToUtc('2026-11-02', '14:00', Z)).toISOString()).toBe(
			'2026-11-02T07:00:00.000Z'
		);
	});
	it('09:00 WIB anchor minus 1 day for a task due 2026-11-05 is 2026-11-04T02:00Z', () => {
		expect(new Date(zonedToUtc('2026-11-05', '09:00', Z) - 86_400_000).toISOString()).toBe(
			'2026-11-04T02:00:00.000Z'
		);
	});
	it('timed event crossing midnight WIB shows on both team days; 17:00Z is 00:00 next WIB day', () => {
		const ev: EventTiming = {
			...base,
			allDay: false,
			startOn: null,
			endOn: null,
			startAt: Date.UTC(2026, 10, 2, 16, 0), // 23:00 WIB Nov 2
			endAt: Date.UTC(2026, 10, 2, 18, 0) // 01:00 WIB Nov 3
		};
		expect(expandEvent(ev, '2026-11-02', '2026-11-02', new Set(), Z)).toHaveLength(1);
		expect(expandEvent(ev, '2026-11-03', '2026-11-03', new Set(), Z)).toHaveLength(1);
		expect(expandEvent(ev, '2026-11-04', '2026-11-04', new Set(), Z)).toHaveLength(0);
	});
	it('timed event ending exactly at 00:00 WIB (end exclusive) does not touch the next day', () => {
		const ev: EventTiming = {
			...base,
			allDay: false,
			startOn: null,
			endOn: null,
			startAt: zonedToUtc('2026-11-02', '22:00', Z),
			endAt: zonedToUtc('2026-11-03', '00:00', Z)
		};
		expect(expandEvent(ev, '2026-11-03', '2026-11-03', new Set(), Z)).toHaveLength(0);
	});
	it('all-day 3 days covers 3 days, not the 4th', () => {
		const ev: EventTiming = {
			...base,
			allDay: true,
			startOn: '2026-11-02',
			endOn: '2026-11-04',
			startAt: null,
			endAt: null
		};
		const days = ['02', '03', '04', '05'].map(
			(d) => expandEvent(ev, `2026-11-${d}`, `2026-11-${d}`, new Set(), Z).length
		);
		expect(days).toEqual([1, 1, 1, 0]);
	});
	it('week starts Monday: Sun 2026-11-01 -> Mon 2026-10-26; Mon stays', () => {
		expect(startOfWeek('2026-11-01')).toBe('2026-10-26');
		expect(startOfWeek('2026-11-02')).toBe('2026-11-02');
		expect(weekRange('2026-11-01')).toEqual({ from: '2026-10-26', to: '2026-11-01' });
	});
	it('month grid Nov 2026: starts Mon Oct 26, 42 days to Dec 6', () => {
		expect(monthGrid('2026-11-15')).toEqual({ from: '2026-10-26', to: '2026-12-06' });
		expect(monthGrid('2028-02-10').from).toBe('2028-01-31'); // Feb 2028 leap, 1st is Tue
	});
	it('no view: window never over 62 days', () => {
		const w = viewRanges(null, '2026-11-30').window;
		expect(w.from <= w.to).toBe(true);
	});
	it('weekly every 2 weeks until date, end inclusive', () => {
		const ev: EventTiming = {
			allDay: false,
			startOn: null,
			endOn: null,
			startAt: zonedToUtc('2026-11-02', '10:00', Z),
			endAt: zonedToUtc('2026-11-02', '11:00', Z),
			recFreq: 'weekly',
			recInterval: 2,
			recUntilOn: '2026-11-30'
		};
		const dates = expandEvent(ev, '2026-11-01', '2026-12-31', new Set(), Z).map((o) => o.onDate);
		expect(dates).toEqual(['2026-11-02', '2026-11-16', '2026-11-30']);
	});
	it('monthly on the 31st clamps (Jan31, Feb28, Mar31) and leap Feb 29', () => {
		const ev = (y: number): EventTiming => ({
			allDay: true,
			startOn: `${y}-01-31`,
			endOn: `${y}-01-31`,
			startAt: null,
			endAt: null,
			recFreq: 'monthly',
			recInterval: 1,
			recUntilOn: `${y}-03-31`
		});
		expect(
			expandEvent(ev(2027), '2027-01-01', '2027-04-01', new Set(), Z).map((o) => o.onDate)
		).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
		expect(
			expandEvent(ev(2028), '2028-01-01', '2028-04-01', new Set(), Z).map((o) => o.onDate)
		).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
	});
});
