import { describe, expect, it } from 'vitest';
import { canonicalizeQuery } from '../pm/query';
import { PM_LIMITS, parseBulk, ISSUE_BULK_FIELDS } from '../pm/validation';
import { activeFilterCount, issueQuery, nextDay, parseIssueParams } from './filters';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const params = (q: string | [string, string][]) => new URLSearchParams(q);

describe('parseIssueParams', () => {
	it('defaults: no filter, newest update first, page 1, nothing ignored', () => {
		const p = parseIssueParams(params(''));
		expect(p.sort).toEqual({ sort: 'updated', dir: 'desc' });
		expect(p.page).toBe(1);
		expect(p.ignored).toBe(0);
		expect(activeFilterCount(p.filters)).toBe(0);
	});

	it('reads every filter, upper-cases project keys, lower-cases ids', () => {
		const p = parseIssueParams(
			params([
				['type', 'bug'],
				['status', 'todo'],
				['priority', 'high'],
				['label', uuid(1).toUpperCase()],
				['assignee', 'none'],
				['reporter', 'me'],
				['project', 'ops'],
				['milestone', 'none'],
				['created_from', '2026-10-01'],
				['created_to', '2026-10-31'],
				['updated_from', '2026-01-01'],
				['updated_to', '2026-12-31'],
				['archived', '1'],
				['sort', 'due'],
				['dir', 'asc'],
				['page', '3']
			])
		);
		expect(p.filters).toEqual({
			types: ['bug'],
			statuses: ['todo'],
			priorities: ['high'],
			labels: [uuid(1)],
			assignee: 'none',
			reporter: 'me',
			projects: ['OPS'],
			milestone: 'none',
			createdFrom: '2026-10-01',
			createdTo: '2026-10-31',
			updatedFrom: '2026-01-01',
			updatedTo: '2026-12-31',
			archived: true
		});
		expect(p.sort).toEqual({ sort: 'due', dir: 'asc' });
		expect(p.page).toBe(3);
		expect(p.ignored).toBe(0);
		expect(activeFilterCount(p.filters)).toBe(11);
	});

	it('drops invalid values and counts them: unknown type, bad uuid, 2026-02-30, 7 projects, 9 labels', () => {
		const p = parseIssueParams(
			params([
				['type', 'epic'],
				['label', 'not-a-uuid'],
				['created_from', '2026-02-30'],
				['updated_to', '1999-12-31'],
				...Array.from({ length: 7 }, (_, i) => ['project', `P${i}X`] as [string, string]),
				...Array.from({ length: 9 }, (_, i) => ['label', uuid(i)] as [string, string]),
				['assignee', "x' or 1=1 --"],
				['sort', ';drop'],
				['archived', 'yes']
			])
		);
		expect(p.filters.types).toEqual([]);
		expect(p.filters.projects).toHaveLength(6);
		expect(p.filters.labels).toHaveLength(8);
		expect(p.filters.createdFrom).toBeNull();
		expect(p.filters.updatedTo).toBeNull();
		expect(p.filters.assignee).toBe('any');
		expect(p.filters.archived).toBe(false);
		expect(p.sort.sort).toBe('updated');
		// epic, bad uuid, two dates, 7th project, 9th label, assignee, sort, archived
		expect(p.ignored).toBe(9);
	});

	it('all values of an enum ticked is no filter; duplicates count once', () => {
		const p = parseIssueParams(
			params([
				['type', 'task'],
				['type', 'bug'],
				['type', 'feature_request'],
				['type', 'improvement'],
				['status', 'done'],
				['status', 'done']
			])
		);
		expect(p.filters.types).toEqual([]);
		expect(p.filters.statuses).toEqual(['done']);
	});

	it('page 1..200: 201, 0 and abc fall back to 1', () => {
		expect(parseIssueParams(params('page=200')).page).toBe(200);
		for (const v of ['201', '0', 'abc', '-1', '1e2'])
			expect(parseIssueParams(params(`page=${v}`)).page).toBe(1);
	});

	it('nextDay crosses months and years', () => {
		expect(nextDay('2026-02-28')).toBe('2026-03-01');
		expect(nextDay('2024-02-28')).toBe('2024-02-29');
		expect(nextDay('2026-12-31')).toBe('2027-01-01');
	});
});

describe('canonicalizeQuery(issues)', () => {
	it('keeps only whitelisted keys in a fixed order; never page', () => {
		expect(
			canonicalizeQuery(
				'issues',
				params('x=<script>&sort=;drop&page=4&project=ops&type=bug&dir=asc&status=todo')
			)
		).toBe('type=bug&status=todo&project=OPS&dir=asc');
		expect(canonicalizeQuery('issues', params(''))).toBe('');
	});

	it('round-trips through the page parser', () => {
		const q = 'type=bug&priority=high&reporter=me&archived=1&sort=created';
		const canonical = canonicalizeQuery('issues', params(q))!;
		const again = parseIssueParams(params(canonical));
		expect(issueQuery(again.filters, again.sort).toString()).toBe(canonical);
	});

	it('the worst case stays under PM_LIMITS.issueViewQueryMax (1 000)', () => {
		const worst = params([
			...['task', 'bug', 'feature_request'].map((t) => ['type', t] as [string, string]),
			...['backlog', 'todo', 'in_progress', 'in_review', 'done'].map(
				(s) => ['status', s] as [string, string]
			),
			...['urgent', 'high', 'medium', 'low'].map((p) => ['priority', p] as [string, string]),
			...Array.from({ length: 8 }, (_, i) => ['label', uuid(i)] as [string, string]),
			['assignee', uuid(90)],
			['reporter', uuid(91)],
			...Array.from({ length: 6 }, (_, i) => ['project', `ABCDEFGHI${i}`] as [string, string]),
			['milestone', uuid(92)],
			['created_from', '2026-01-01'],
			['created_to', '2026-12-31'],
			['updated_from', '2026-01-01'],
			['updated_to', '2026-12-31'],
			['archived', '1'],
			['sort', 'priority'],
			['dir', 'asc']
		]);
		const out = canonicalizeQuery('issues', worst);
		expect(out).not.toBeNull();
		expect(out!.length).toBeLessThanOrEqual(PM_LIMITS.issueViewQueryMax);
		expect(out!.length).toBeGreaterThan(PM_LIMITS.viewQueryMax);
	});

	it('project views keep their 500-character limit and keys', () => {
		expect(canonicalizeQuery('list', params('type=bug&status=todo'))).toBe('status=todo');
	});
});

describe('parseBulk for the Issues bar', () => {
	const form = (pairs: [string, string][]) => {
		const f = new FormData();
		for (const [k, v] of pairs) f.append(k, v);
		return f;
	};
	it('accepts type and team labels; refuses milestone and project labels', () => {
		expect(
			parseBulk(
				form([
					['taskId', uuid(1)],
					['type', 'bug'],
					['addTeamLabelId', uuid(2)]
				]),
				ISSUE_BULK_FIELDS
			)
		).toMatchObject({ ok: true, changes: { type: 'bug', addTeamLabelId: uuid(2) } });
		for (const field of ['milestoneId', 'addLabelId', 'removeLabelId'])
			expect(
				parseBulk(
					form([
						['taskId', uuid(1)],
						[field, uuid(3)]
					]),
					ISSUE_BULK_FIELDS
				).ok
			).toBe(false);
		expect(
			parseBulk(
				form([
					['taskId', uuid(1)],
					['type', 'epic']
				]),
				ISSUE_BULK_FIELDS
			)
		).toMatchObject({ ok: false, errors: { type: 'Choose a type.' } });
	});
});
