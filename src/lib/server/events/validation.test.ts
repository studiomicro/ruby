import { describe, expect, it } from 'vitest';
import { EVENT_MESSAGES, parseEventForm } from './validation';

const JKT = 'Asia/Jakarta';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function form(fields: Record<string, string | string[]>) {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields))
		for (const value of Array.isArray(v) ? v : [v]) f.append(k, value);
	return f;
}
const base = {
	title: 'Design review',
	startDate: '2026-11-02',
	startTime: '14:00',
	endDate: '2026-11-02',
	endTime: '15:30'
};
const parse = (extra: Record<string, string | string[]> = {}) =>
	parseEventForm(form({ ...base, ...extra }), JKT);
const errorsOf = (extra: Record<string, string | string[]>) => {
	const r = parse(extra);
	return r.ok ? {} : r.errors;
};

describe('parseEventForm', () => {
	it('a timed event converts team wall clock to UTC (criterion 10)', () => {
		const r = parse();
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(new Date(r.value.startAt!).toISOString()).toBe('2026-11-02T07:00:00.000Z');
		expect(new Date(r.value.endAt!).toISOString()).toBe('2026-11-02T08:30:00.000Z');
		expect(r.value).toMatchObject({
			allDay: false,
			visibility: 'team',
			firstOn: '2026-11-02',
			lastOn: '2026-11-02',
			recFreq: null
		});
	});
	it('an all-day event keeps inclusive dates', () => {
		const r = parse({ allDay: 'on', endDate: '2026-11-04' });
		expect(r.ok && r.value).toMatchObject({
			startOn: '2026-11-02',
			endOn: '2026-11-04',
			startAt: null,
			lastOn: '2026-11-04'
		});
	});
	it('limits (criterion 11)', () => {
		expect(errorsOf({ title: '' }).title).toBe(EVENT_MESSAGES.titleRequired);
		expect(errorsOf({ title: 'x'.repeat(121) }).title).toBe(EVENT_MESSAGES.titleLong);
		expect(parse({ title: 'x'.repeat(120) }).ok).toBe(true);
		expect(errorsOf({ description: 'x'.repeat(5001) }).description).toBe(
			EVENT_MESSAGES.descriptionLong
		);
		expect(errorsOf({ location: 'x'.repeat(201) }).location).toBe(EVENT_MESSAGES.locationLong);
		expect(errorsOf({ endTime: '13:00' }).end).toBe(EVENT_MESSAGES.endBeforeStart);
		expect(errorsOf({ endDate: '2026-11-17' }).end).toBe(EVENT_MESSAGES.timedTooLong);
		expect(errorsOf({ allDay: 'on', endDate: '2026-12-03' }).end).toBe(
			EVENT_MESSAGES.allDayTooLong
		);
		expect(parse({ allDay: 'on', endDate: '2026-12-02' }).ok).toBe(true);
		expect(errorsOf({ startTime: '14:03' }).start).toBe(EVENT_MESSAGES.time);
		expect(errorsOf({ startDate: '1999-01-01' }).start).toBe(EVENT_MESSAGES.date);
		expect(errorsOf({ attendees: Array.from({ length: 51 }, (_, i) => U(i)) }).attendees).toBe(
			EVENT_MESSAGES.attendeesTooMany
		);
		expect(errorsOf({ attendees: ['not-a-user'] }).attendees).toBe(EVENT_MESSAGES.attendee);
		expect(errorsOf({ projectId: 'OPS' }).projectId).toBe(EVENT_MESSAGES.project);
		expect(errorsOf({ visibility: 'public' }).visibility).toBe(EVENT_MESSAGES.visibility);
	});
	it('title and location are cleaned single-line text', () => {
		const r = parse({ title: '  A‮​B\nC ', location: 'Room\t1' });
		expect(r.ok && r.value.title).toBe('AB C');
		expect(r.ok && r.value.location).toBe('Room 1');
	});
	it('recurrence (criterion 13)', () => {
		const weekly = parse({ repeat: 'weekly', interval: '2', ends: 'until', until: '2026-12-14' });
		expect(weekly.ok && weekly.value).toMatchObject({
			recFreq: 'weekly',
			recInterval: 2,
			recUntilOn: '2026-12-14',
			lastOn: '2026-12-14'
		});
		const daily = parse({ repeat: 'daily', ends: 'count', count: '10' });
		expect(daily.ok && daily.value.recUntilOn).toBe('2026-11-11');
		const monthly = parse({
			startDate: '2026-01-31',
			endDate: '2026-01-31',
			repeat: 'monthly',
			ends: 'count',
			count: '3'
		});
		expect(monthly.ok && monthly.value.recUntilOn).toBe('2026-03-31');
		expect(errorsOf({ repeat: 'weekly', interval: '0', ends: 'count', count: '2' }).repeat).toBe(
			EVENT_MESSAGES.interval
		);
		expect(errorsOf({ repeat: 'weekly', interval: '31', ends: 'count', count: '2' }).repeat).toBe(
			EVENT_MESSAGES.interval
		);
		expect(errorsOf({ repeat: 'weekly' }).repeat).toBe(EVENT_MESSAGES.endsRequired);
		expect(errorsOf({ repeat: 'daily', ends: 'count', count: '501' }).repeat).toBe(
			EVENT_MESSAGES.count
		);
		// 517 daily occurrences are over 500.
		expect(errorsOf({ repeat: 'daily', ends: 'until', until: '2028-04-01' }).repeat).toBe(
			EVENT_MESSAGES.seriesTooLong
		);
		expect(errorsOf({ repeat: 'weekly', ends: 'until', until: '2028-11-03' }).repeat).toBe(
			EVENT_MESSAGES.seriesTooLong
		);
		expect(parse({ repeat: 'weekly', ends: 'until', until: '2028-11-02' }).ok).toBe(true);
		expect(errorsOf({ repeat: 'weekly', ends: 'until', until: '2026-11-01' }).repeat).toBe(
			EVENT_MESSAGES.untilBeforeStart
		);
	});
});
