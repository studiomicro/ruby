import { describe, expect, it } from 'vitest';
import { zonedToUtc } from '#lib/shared/calendar';
import { eventSummary, personalSummary, taskSummary } from './summary';

const JKT = 'Asia/Jakarta';
const at = zonedToUtc('2026-11-04', '09:00', JKT);

describe('reminder summaries', () => {
	it('tasks say when they are due, in team days', () => {
		const t = { ref: 'OPS-12', title: 'Fix login', dueOn: '2026-11-05' };
		expect(taskSummary(t, at, JKT)).toBe('OPS-12 Fix login is due tomorrow');
		expect(taskSummary({ ...t, dueOn: '2026-11-04' }, at, JKT)).toBe(
			'OPS-12 Fix login is due today'
		);
		expect(taskSummary({ ...t, dueOn: '2026-11-11' }, at, JKT)).toBe(
			'OPS-12 Fix login is due in 7 days'
		);
		expect(taskSummary({ ...t, dueOn: null }, at, JKT)).toBe('OPS-12 Fix login');
	});
	it('events say when they start', () => {
		const start = zonedToUtc('2026-11-04', '10:00', JKT);
		expect(
			eventSummary(
				{ title: 'Design review', allDay: false },
				{ onDate: '2026-11-04', startAt: start },
				at,
				JKT
			)
		).toBe('Design review starts in 1 hour');
		expect(
			eventSummary(
				{ title: 'Standup', allDay: false },
				{ onDate: '2026-11-04', startAt: at + 10 * 60_000 },
				at,
				JKT
			)
		).toBe('Standup starts in 10 minutes');
		expect(
			eventSummary(
				{ title: 'Offsite', allDay: true },
				{ onDate: '2026-11-05', startAt: 0 },
				at,
				JKT
			)
		).toBe('Offsite is tomorrow');
	});
	it('is plain text of at most 140 characters, control characters stripped, phrase kept', () => {
		const s = taskSummary(
			{ ref: 'OPS-1', title: `x\u0000‮${'y'.repeat(300)}`, dueOn: '2026-11-05' },
			at,
			JKT
		);
		expect(Array.from(s).length).toBeLessThanOrEqual(140);
		expect(s).toMatch(/is due tomorrow$/);
		expect(s.includes('\u0000') || s.includes('\u202e')).toBe(false);
		expect(personalSummary('  Call\nthe bank  ')).toBe('Call the bank');
		expect(personalSummary('<b>*bold*</b>')).toBe('<b>*bold*</b>');
	});
});
