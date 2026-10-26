import { describe, expect, it } from 'vitest';
import { moveActionUrl, statusListUrl, withParams } from './links';
import { formatDue, isOverdue, peopleOptions } from './options';

describe('task UI helpers', () => {
	it('overdue only for open tasks before today', () => {
		expect(isOverdue({ dueOn: '2026-10-25', status: 'todo' }, '2026-10-26')).toBe(true);
		expect(isOverdue({ dueOn: '2026-10-26', status: 'todo' }, '2026-10-26')).toBe(false);
		expect(isOverdue({ dueOn: '2026-10-25', status: 'done' }, '2026-10-26')).toBe(false);
		expect(isOverdue({ dueOn: '2026-10-25', status: 'canceled' }, '2026-10-26')).toBe(false);
		expect(isOverdue({ dueOn: null, status: 'todo' }, '2026-10-26')).toBe(false);
	});

	it('formatDue shows the calendar date without a time-zone shift', () => {
		expect(formatDue('2026-01-01', '2026-10-26')).toBe('Jan 1');
		expect(formatDue('2027-01-01', '2026-10-26')).toBe('Jan 1, 2027');
	});

	it('peopleOptions keeps a disabled current person', () => {
		const users = [{ id: 'a', name: 'Ana' }];
		expect(peopleOptions(users, { id: 'b', name: 'Bo' }).map((o) => o.label)).toEqual([
			'Nobody',
			'Ana',
			'Bo (disabled)'
		]);
		expect(peopleOptions(users, { id: 'a', name: 'Ana' })).toHaveLength(2);
	});

	it('links keep filters and drop action keys and the delete notice', () => {
		expect(moveActionUrl('?view=board&status=todo&/move')).toBe('?view=board&status=todo&/move');
		expect(moveActionUrl('')).toBe('?/move');
		expect(withParams('/projects/OPS', '?page=2&deleted=OPS-1&sort=due', { page: null })).toBe(
			'/projects/OPS?sort=due'
		);
		expect(
			statusListUrl('/projects/OPS', 'done', { priorities: ['high'], assignee: { userId: 'u' } })
		).toBe('/projects/OPS?status=done&priority=high&assignee=u');
	});
});
