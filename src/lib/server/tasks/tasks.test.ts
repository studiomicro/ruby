import { describe, expect, it } from 'vitest';
import { canDeleteTask, canManageProject } from '../projects/permissions';
import { normaliseKey, parseProjectCreate, parseProjectEdit } from '../projects/validation';
import { conflictFields } from './conflict';
import { dueBucket, isValidDueOn, todayIn } from './dates';
import { formatTaskRef, taskPath } from './format';
import { needsRenumber, positionBetween } from './position';
import type { TaskDetail } from './repo';
import {
	cleanBody,
	cleanLine,
	filtersQuery,
	LIMITS,
	parseExpected,
	parseFilters,
	parseMove,
	parsePage,
	parsePatch,
	parseSort,
	parseTaskFields
} from './validation';

const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const ID2 = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d';
const formOf = (entries: Record<string, string> | [string, string][]) => {
	const f = new FormData();
	for (const [k, v] of Array.isArray(entries) ? entries : Object.entries(entries)) f.append(k, v);
	return f;
};
const DEFAULTS = {
	title: '',
	description: '',
	status: 'todo',
	priority: 'none',
	assigneeId: null,
	dueOn: null,
	milestoneId: null
} as const;

describe('project keys', () => {
	it.each([
		['ops', 'OPS'],
		[' Ops1 ', 'OPS1'],
		['AB', 'AB'],
		['ABCDEFGHIJ', 'ABCDEFGHIJ']
	])('%s → %s', (input, key) => expect(normaliseKey(input)).toBe(key));

	it.each(['A', '1AB', 'ABCDEFGHIJK', 'A-B', 'ÄB', 'ßA', 'A B', '', 'AB​'])(
		'%j is refused',
		(input) => expect(normaliseKey(input)).toBeNull()
	);

	it('reserves NEW and ignores a key on edit', () => {
		expect(parseProjectCreate(formOf({ key: 'new', name: 'x' }))).toMatchObject({
			ok: false,
			errors: { key: expect.any(String) }
		});
		const edit = parseProjectEdit(
			formOf({ key: 'HACK', name: 'Name', expectedUpdatedAt: '5', leadId: '' })
		);
		expect(edit).toEqual({
			ok: true,
			value: { name: 'Name', description: '', leadId: null },
			expected: 5
		});
	});

	it('project name 1–80, description ≤ 5000, lead must be an id', () => {
		const r = parseProjectCreate(
			formOf({ key: 'OPS', name: 'n'.repeat(81), description: 'd'.repeat(5001), leadId: 'x' })
		);
		expect(r).toMatchObject({
			ok: false,
			errors: {
				name: expect.any(String),
				description: expect.any(String),
				leadId: expect.any(String)
			}
		});
		expect(
			parseProjectCreate(
				formOf({ key: 'OPS', name: 'n'.repeat(80), description: 'd'.repeat(5000) })
			)
		).toMatchObject({ ok: true });
	});
});

describe('text cleaning', () => {
	it('cleanLine strips invisible characters, collapses lines and flags over-long input', () => {
		expect(cleanLine(' a‮​b\nc\u0000 ', 10)).toEqual({ value: 'ab c', tooLong: false });
		expect(cleanLine('x'.repeat(11), 10)).toEqual({ value: 'x'.repeat(10), tooLong: true });
	});
	it('cleanBody keeps newlines and tabs, drops other controls, normalises CRLF', () => {
		expect(cleanBody('a\r\nb\t\u0007c\u009f\r')).toBe('a\nb\tc');
	});
});

describe('task fields', () => {
	it('boundaries: title 1/200 ok, 0/201 refused; description 20 000 ok, 20 001 refused', () => {
		const ok = parseTaskFields(
			formOf({ title: 'x'.repeat(200), description: 'd'.repeat(LIMITS.descriptionMax) }),
			DEFAULTS
		);
		expect(ok.ok).toBe(true);
		expect(parseTaskFields(formOf({ title: 'x' }), DEFAULTS).ok).toBe(true);
		const bad = parseTaskFields(
			formOf({ title: 'x'.repeat(201), description: 'd'.repeat(20_001) }),
			DEFAULTS
		);
		expect(bad).toMatchObject({
			ok: false,
			errors: { title: expect.any(String), description: expect.any(String) }
		});
		expect(parseTaskFields(formOf({ title: '   ' }), DEFAULTS)).toMatchObject({
			ok: false,
			errors: { title: 'Enter a title.' }
		});
	});

	it('missing fields keep the fallback; enums, assignee and due are checked', () => {
		const r = parseTaskFields(formOf({ title: 'T' }), {
			...DEFAULTS,
			status: 'done',
			assigneeId: ID
		});
		expect(r).toEqual({
			ok: true,
			value: { ...DEFAULTS, title: 'T', status: 'done', assigneeId: ID }
		});
		const bad = parseTaskFields(
			formOf({ title: 'T', status: 'x', priority: 'p', assigneeId: 'u', dueOn: '2026-02-30' }),
			DEFAULTS
		);
		expect(bad).toMatchObject({
			ok: false,
			errors: {
				status: expect.any(String),
				priority: expect.any(String),
				assigneeId: expect.any(String),
				dueOn: expect.any(String)
			}
		});
		expect(
			parseTaskFields(formOf({ title: 'T', assigneeId: '', dueOn: '' }), DEFAULTS)
		).toMatchObject({
			ok: true,
			value: { assigneeId: null, dueOn: null }
		});
	});

	it('patch reads one known field', () => {
		expect(parsePatch(formOf({ field: 'priority', value: 'urgent' }))).toEqual({
			ok: true,
			field: 'priority',
			value: 'urgent'
		});
		expect(parsePatch(formOf({ field: 'assigneeId', value: '' }))).toEqual({
			ok: true,
			field: 'assigneeId',
			value: null
		});
		expect(parsePatch(formOf({ field: 'createdBy', value: ID }))).toMatchObject({ ok: false });
		expect(parsePatch(formOf({ field: '__proto__', value: 'x' }))).toMatchObject({ ok: false });
		expect(parsePatch(formOf({ field: 'status', value: 'nope' }))).toMatchObject({
			ok: false,
			field: 'status'
		});
	});

	it('expectedUpdatedAt is a non-negative safe integer', () => {
		expect(parseExpected('0')).toBe(0);
		expect(parseExpected('1792993974665')).toBe(1792993974665);
		for (const raw of ['', '-1', '1.5', '1e3', '99999999999999999', 'abc'])
			expect(parseExpected(raw)).toBeNull();
	});
});

describe('moves', () => {
	it('exactly one of afterTaskId and place', () => {
		expect(parseMove(formOf({ taskId: ID, status: 'done', place: 'top' }))).toEqual({
			ok: true,
			taskId: ID,
			status: 'done',
			placement: { place: 'top' }
		});
		expect(parseMove(formOf({ taskId: ID, status: 'done', afterTaskId: '' }))).toMatchObject({
			ok: true,
			placement: { after: null }
		});
		expect(parseMove(formOf({ taskId: ID, status: 'done', afterTaskId: ID2 }))).toMatchObject({
			placement: { after: ID2 }
		});
		for (const f of <Record<string, string>[]>[
			{ taskId: ID, status: 'done' },
			{ taskId: ID, status: 'done', place: 'top', afterTaskId: '' },
			{ taskId: ID, status: 'done', place: 'middle' },
			{ taskId: ID, status: 'done', afterTaskId: 'x' },
			{ taskId: 'x', status: 'done', place: 'top' },
			{ taskId: ID, status: 'closed', place: 'top' }
		])
			expect(parseMove(formOf(f)).ok, JSON.stringify(f)).toBe(false);
	});

	it('positionBetween and needsRenumber', () => {
		expect(positionBetween(null, null)).toBe(0);
		expect(positionBetween(null, 100)).toBe(100 - 1024);
		expect(positionBetween(100, null)).toBe(1124);
		expect(positionBetween(1, 2)).toBe(1.5);
		const mid = positionBetween(1, 1 + 1e-5);
		expect(mid).toBeGreaterThan(1);
		expect(mid).toBeLessThan(1 + 1e-5);
		expect(needsRenumber(1, 1 + 1e-7)).toBe(true);
		expect(needsRenumber(1, 1)).toBe(true);
		expect(needsRenumber(1, 1 + 1e-5)).toBe(false);
		expect(needsRenumber(null, 1)).toBe(false);
		expect(needsRenumber(1, null)).toBe(false);
	});
});

describe('dates', () => {
	it.each([
		['2026-10-26', true],
		['2000-01-01', true],
		['2100-12-31', true],
		['2024-02-29', true],
		['2026-02-29', false],
		['2026-02-30', false],
		['2026-1-1', false],
		['1999-12-31', false],
		['2101-01-01', false],
		['2026-13-01', false],
		['26-10-2026', false],
		['', false]
	])('isValidDueOn(%j) = %s', (s, ok) => expect(isValidDueOn(s)).toBe(ok));

	it('todayIn follows the zone across midnight; an unknown zone falls back to UTC', () => {
		// 2026-10-26 17:30 UTC is already 2026-10-27 00:30 in Jakarta (UTC+7).
		const at = Date.UTC(2026, 9, 26, 17, 30);
		expect(todayIn('Asia/Jakarta', at)).toBe('2026-10-27');
		expect(todayIn('UTC', at)).toBe('2026-10-26');
		expect(todayIn('America/Los_Angeles', at)).toBe('2026-10-26');
		expect(todayIn('Not/AZone', at)).toBe('2026-10-26');
		expect(todayIn(undefined, at)).toBe('2026-10-26');
	});

	it('dueBucket', () => {
		expect(dueBucket(null, '2026-10-26')).toBe('none');
		expect(dueBucket('2026-10-25', '2026-10-26')).toBe('overdue');
		expect(dueBucket('2026-10-26', '2026-10-26')).toBe('today');
		expect(dueBucket('2026-10-27', '2026-10-26')).toBe('upcoming');
	});
});

describe('filters', () => {
	it('drops unknown values; all values chosen means no filter; assignee me/none/uuid', () => {
		const p = new URLSearchParams('status=todo&status=bogus&priority=high&assignee=me');
		expect(parseFilters(p)).toEqual({
			statuses: ['todo'],
			priorities: ['high'],
			assignee: 'me',
			labels: [],
			milestone: 'any'
		});
		const all = new URLSearchParams(
			'status=backlog&status=todo&status=in_progress&status=in_review&status=done&status=canceled'
		);
		expect(parseFilters(all).statuses).toEqual([]);
		expect(parseFilters(new URLSearchParams(`assignee=${ID.toUpperCase()}`)).assignee).toEqual({
			userId: ID
		});
		expect(parseFilters(new URLSearchParams('assignee=nobody')).assignee).toBe('any');
	});

	it('sort, dir and page are whitelisted', () => {
		expect(parseSort(new URLSearchParams('sort=due&dir=asc'))).toEqual({ sort: 'due', dir: 'asc' });
		expect(parseSort(new URLSearchParams('sort=drop table&dir=x'))).toEqual({
			sort: 'number',
			dir: 'desc'
		});
		for (const [raw, n] of [
			['3', 3],
			['0', 1],
			['10000', 10000],
			['10001', 1],
			['-2', 1],
			['1e3', 1]
		] as const)
			expect(parsePage(new URLSearchParams(`page=${raw}`))).toBe(n);
	});

	it('filtersQuery round-trips', () => {
		const f = parseFilters(new URLSearchParams(`status=done&priority=low&assignee=${ID}`));
		expect(parseFilters(filtersQuery(f))).toEqual(f);
	});
});

describe('permissions', () => {
	const project = { leadId: 'lead', createdBy: 'creator' };
	it('manage: lead, creator or admin', () => {
		expect(canManageProject({ id: 'lead', role: 'member' }, project)).toBe(true);
		expect(canManageProject({ id: 'creator', role: 'member' }, project)).toBe(true);
		expect(canManageProject({ id: 'x', role: 'admin' }, project)).toBe(true);
		expect(canManageProject({ id: 'x', role: 'member' }, project)).toBe(false);
	});
	it('delete task: task creator, project lead or admin (not the project creator)', () => {
		const task = { createdBy: 'author' };
		expect(canDeleteTask({ id: 'author', role: 'member' }, project, task)).toBe(true);
		expect(canDeleteTask({ id: 'lead', role: 'member' }, project, task)).toBe(true);
		expect(canDeleteTask({ id: 'x', role: 'admin' }, project, task)).toBe(true);
		expect(canDeleteTask({ id: 'creator', role: 'member' }, project, task)).toBe(false);
	});
});

describe('format and conflicts', () => {
	it('formatTaskRef and taskPath', () => {
		expect(formatTaskRef('OPS', 12)).toBe('OPS-12');
		expect(taskPath('OPS', 12)).toBe('/projects/OPS/tasks/12');
	});

	it('conflictFields lists only differing submitted fields, as display text', () => {
		const current = {
			title: 'A',
			description: '',
			status: 'todo',
			priority: 'high',
			assigneeId: ID,
			assigneeName: 'Dewi',
			dueOn: null
		} as unknown as TaskDetail;
		const names = new Map([[ID2, 'Budi']]);
		expect(
			conflictFields(
				current,
				{ title: 'A', status: 'done', priority: 'high', assigneeId: ID2, dueOn: '2026-11-01' },
				names
			)
		).toEqual([
			{ field: 'status', label: 'Status', theirs: 'To do', mine: 'Done' },
			{ field: 'assigneeId', label: 'Assignee', theirs: 'Dewi', mine: 'Budi' },
			{ field: 'dueOn', label: 'Due date', theirs: 'None', mine: '2026-11-01' }
		]);
	});
});
