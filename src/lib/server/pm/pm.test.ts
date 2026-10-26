import { describe, expect, it } from 'vitest';
import { LABEL_COLORS } from '#lib/shared/enums';
import { mergeColumns } from './columns';
import { progressFrom } from './milestones';
import { canonicalizeQuery } from './query';
import {
	labelNameKey,
	parseBulk,
	parseCheckText,
	parseColumns,
	parseLabel,
	parseLabelSets,
	parseMilestone,
	parseWip,
	PM_LIMITS
} from './validation';

/** RB-08 pure logic: query canonicalisation, name keys, column merge, progress maths and the form parsers. */

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const formOf = (fields: Record<string, string> | [string, string][]) => {
	const f = new FormData();
	for (const [k, v] of Array.isArray(fields) ? fields : Object.entries(fields)) f.append(k, v);
	return f;
};
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

describe('canonicalizeQuery', () => {
	it.each([
		['list', 'status=todo&status=done&priority=high', 'status=todo&status=done&priority=high'],
		['list', 'x=%3Cscript%3E&status=todo', 'status=todo'],
		['list', 'sort=;drop&dir=asc', 'dir=asc'],
		['list', 'sort=due&dir=sideways', 'sort=due'],
		['list', 'status=bogus&priority=nope&assignee=everyone', ''],
		['list', 'assignee=me&milestone=none', 'assignee=me&milestone=none'],
		['list', `label=${ID.toUpperCase()}&label=${ID}&label=bad`, `label=${ID}`],
		['list', `milestone=${ID}&page=4&deleted=OPS-1`, `milestone=${ID}`],
		['list', 'view=board&status=todo', 'status=todo'],
		['board', 'status=todo&sort=due&dir=asc', 'view=board&status=todo'],
		['board', '', 'view=board'],
		['list', 'status=todo&status=todo', 'status=todo']
	] as const)('%s ?%s → %s', (kind, raw, out) => {
		expect(canonicalizeQuery(kind, new URLSearchParams(raw))).toBe(out);
	});

	it('the order is fixed whatever the input order', () => {
		expect(canonicalizeQuery('list', new URLSearchParams(`dir=asc&label=${ID}&status=todo`))).toBe(
			`status=todo&label=${ID}&dir=asc`
		);
	});

	it('refuses a result over 500 characters (null), accepts one under', () => {
		const many = Array.from({ length: 11 }, (_, i) => `label=${uuid(i)}`).join('&');
		expect(canonicalizeQuery('list', new URLSearchParams(many))).toHaveLength(11 * 43 - 1);
		const tooMany = Array.from({ length: 30 }, (_, i) => `label=${uuid(i)}`).join('&');
		expect(canonicalizeQuery('list', new URLSearchParams(tooMany))).toBeNull();
	});
});

describe('labels', () => {
	it('name key ignores case: Bug and bUG clash', () => {
		expect(labelNameKey('Bug')).toBe(labelNameKey('bUG'));
		expect(labelNameKey('Ärger')).toBe('ärger');
	});

	it('name 1-30 single line, cleaned; colour in the enum', () => {
		const ok = parseLabel(formOf({ name: '  Needs​  design \n', color: 'red' }));
		expect(ok).toEqual({
			ok: true,
			value: { name: 'Needs design', nameKey: 'needs design', color: 'red' }
		});
		expect(parseLabel(formOf({ name: 'x'.repeat(30), color: 'gray' })).ok).toBe(true);
		expect(parseLabel(formOf({ name: 'x'.repeat(31), color: 'gray' }))).toMatchObject({
			ok: false,
			errors: { name: expect.stringContaining('30') }
		});
		expect(parseLabel(formOf({ name: ' ', color: 'gray' }))).toMatchObject({
			ok: false,
			errors: { name: 'Enter a label name.' }
		});
		for (const color of ['teal', 'RED', '', 'red;']) {
			expect(parseLabel(formOf({ name: 'Bug', color }))).toMatchObject({
				ok: false,
				errors: { color: expect.any(String) }
			});
		}
		expect(LABEL_COLORS).toHaveLength(8);
		for (const color of LABEL_COLORS)
			expect(parseLabel(formOf({ name: 'Bug', color })).ok).toBe(true);
	});

	it('a label set: distinct uuids, at most 10 project and team labels together', () => {
		expect(
			parseLabelSets(
				formOf([
					['labelId', ID],
					['labelId', ID.toUpperCase()]
				])
			)
		).toEqual({
			ok: true,
			value: { labelIds: [ID], teamLabelIds: [] }
		});
		expect(parseLabelSets(formOf([]))).toEqual({
			ok: true,
			value: { labelIds: [], teamLabelIds: [] }
		});
		expect(parseLabelSets(formOf([['labelId', 'nope']])).ok).toBe(false);
		expect(parseLabelSets(formOf([['teamLabelId', 'nope']])).ok).toBe(false);
		const ten = Array.from({ length: 10 }, (_, i) => ['labelId', uuid(i)] as [string, string]);
		expect(parseLabelSets(formOf(ten)).ok).toBe(true);
		const eleven = [...ten, ['labelId', uuid(11)] as [string, string]];
		expect(parseLabelSets(formOf(eleven))).toEqual({
			ok: false,
			error: 'A task can have up to 10 labels.'
		});
		// RB-12 D4: the cap counts both kinds.
		const mixed = [
			...ten.slice(0, 6),
			...Array.from({ length: 5 }, (_, i) => ['teamLabelId', uuid(20 + i)] as [string, string])
		];
		expect(parseLabelSets(formOf(mixed)).ok).toBe(false);
		expect(parseLabelSets(formOf(mixed.slice(1)))).toMatchObject({
			ok: true,
			value: { labelIds: ten.slice(1, 6).map((x) => x[1]) }
		});
	});
});

describe('checklist and milestones', () => {
	it('step text 1-200', () => {
		expect(parseCheckText('x'.repeat(200))).toEqual({ value: 'x'.repeat(200) });
		expect(parseCheckText('x'.repeat(201)).error).toContain('200');
		expect(parseCheckText('  ').error).toBe('Enter the step.');
	});

	it('milestone name 1-80, description 0-1000, due date empty or valid', () => {
		expect(parseMilestone(formOf({ name: 'Beta', dueOn: '' }))).toEqual({
			ok: true,
			value: { name: 'Beta', description: '', dueOn: null }
		});
		expect(parseMilestone(formOf({ name: 'x'.repeat(81) })).ok).toBe(false);
		expect(parseMilestone(formOf({ name: 'B', description: 'd'.repeat(1001) })).ok).toBe(false);
		for (const dueOn of ['2026-02-30', '1999-12-31', '2101-01-01', 'soon'])
			expect(parseMilestone(formOf({ name: 'B', dueOn })).ok, dueOn).toBe(false);
		expect(parseMilestone(formOf({ name: 'B', dueOn: '2026-12-01' })).ok).toBe(true);
	});

	it('progress: done over the non-canceled total', () => {
		const p = progressFrom(
			new Map([
				['done', 3],
				['todo', 2],
				['canceled', 4]
			])
		);
		expect(p).toMatchObject({ done: 3, total: 5, percent: 60 });
		expect(p.byStatus.canceled).toBe(4);
		expect(progressFrom(new Map())).toMatchObject({ done: 0, total: 0, percent: 0 });
		expect(progressFrom(new Map([['canceled', 2]]))).toMatchObject({ total: 0, percent: 0 });
		expect(
			progressFrom(
				new Map([
					['done', 1],
					['todo', 2]
				])
			).percent
		).toBe(33);
	});
});

describe('board columns', () => {
	it('WIP limit: empty or a whole number 1-200', () => {
		expect(parseWip('')).toEqual({ ok: true, value: null });
		expect(parseWip(' 3 ')).toEqual({ ok: true, value: 3 });
		expect(parseWip('200')).toEqual({ ok: true, value: 200 });
		for (const bad of ['0', '201', '2.5', '1e2', '-1', 'three', '0003'])
			expect(parseWip(bad).ok, bad).toBe(false);
	});

	it('the form: six rows; empty is default; a long name or bad limit is a field error', () => {
		const parsed = parseColumns(
			formOf({ label_in_review: ' QA ', wip_todo: '3', hidden_canceled: 'on' })
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value).toHaveLength(6);
		expect(parsed.value.find((c) => c.status === 'in_review')).toMatchObject({ label: 'QA' });
		expect(parsed.value.find((c) => c.status === 'todo')).toMatchObject({
			label: null,
			wipLimit: 3,
			hidden: false
		});
		expect(parsed.value.find((c) => c.status === 'canceled')?.hidden).toBe(true);
		expect(parseColumns(formOf({ label_done: 'x'.repeat(25), wip_backlog: '0' }))).toMatchObject({
			ok: false,
			errors: { label_done: expect.any(String), wip_backlog: expect.any(String) }
		});
	});

	it('merge: defaults for missing rows, stored values over them, version = newest row', () => {
		const merged = mergeColumns(
			[
				{ status: 'in_review', label: 'QA', wipLimit: 3, hidden: 0, updatedAt: 50 },
				{ status: 'canceled', label: null, wipLimit: null, hidden: 1, updatedAt: 70 }
			],
			new Map([['in_review', 4]])
		);
		expect(merged.version).toBe(70);
		expect(merged.columns.map((c) => c.label)).toEqual([
			'Backlog',
			'To do',
			'In progress',
			'QA',
			'Done',
			'Canceled'
		]);
		expect(merged.columns[3]).toMatchObject({ customLabel: 'QA', wipLimit: 3, taskCount: 4 });
		expect(merged.columns[5]?.hidden).toBe(true);
		expect(mergeColumns([], new Map()).version).toBe(0);
	});
});

describe('bulk form', () => {
	const ids = (n: number) =>
		Array.from({ length: n }, (_, i) => ['taskId', uuid(i)] as [string, string]);

	it('1-100 distinct ids; at least one change', () => {
		expect(parseBulk(formOf([...ids(100), ['status', 'done']])).ok).toBe(true);
		expect(parseBulk(formOf([...ids(101), ['status', 'done']]))).toMatchObject({
			ok: false,
			errors: { form: 'Select at most 100 tasks at once.' }
		});
		expect(parseBulk(formOf([['status', 'done']]))).toMatchObject({
			ok: false,
			errors: { form: 'Select at least one task.' }
		});
		expect(parseBulk(formOf([...ids(2)]))).toMatchObject({
			ok: false,
			errors: { form: 'Choose at least one change.' }
		});
		const dup = parseBulk(
			formOf([
				['taskId', ID],
				['taskId', ID.toUpperCase()],
				['priority', 'low']
			])
		);
		expect(dup).toMatchObject({ ok: true, taskIds: [ID] });
		expect(
			parseBulk(
				formOf([
					['taskId', 'nope'],
					['priority', 'low']
				])
			).ok
		).toBe(false);
	});

	it('empty is no change; none clears; values are validated', () => {
		const r = parseBulk(
			formOf([
				['taskId', ID],
				['status', ''],
				['priority', 'urgent'],
				['assigneeId', 'none'],
				['milestoneId', ID2],
				['dueOn', '2026-11-30'],
				['addLabelId', ID2]
			])
		);
		expect(r).toEqual({
			ok: true,
			taskIds: [ID],
			changes: {
				priority: 'urgent',
				assigneeId: null,
				milestoneId: ID2,
				dueOn: '2026-11-30',
				addLabelId: ID2
			}
		});
		expect(
			parseBulk(
				formOf([
					['taskId', ID],
					['clearDue', 'on'],
					['dueOn', '2026-11-30']
				])
			)
		).toMatchObject({ ok: true, changes: { dueOn: null } });
		expect(
			parseBulk(
				formOf([
					['taskId', ID],
					['status', 'shipped'],
					['priority', 'x'],
					['assigneeId', 'bob'],
					['dueOn', '2026-02-30'],
					['removeLabelId', 'x']
				])
			)
		).toMatchObject({
			ok: false,
			errors: {
				status: expect.any(String),
				priority: expect.any(String),
				assigneeId: expect.any(String),
				dueOn: expect.any(String),
				removeLabelId: expect.any(String)
			}
		});
		expect(
			parseBulk(
				formOf([
					['taskId', ID],
					['addLabelId', ID2],
					['removeLabelId', ID2]
				])
			).ok
		).toBe(false);
	});

	it('limits match the PRD', () => {
		expect(PM_LIMITS).toMatchObject({
			labelsPerProject: 30,
			labelsPerTask: 10,
			checklistPerTask: 50,
			milestonesPerProject: 50,
			viewsPerUserProject: 20,
			viewQueryMax: 500,
			bulkMax: 100
		});
	});
});
