import {
	TASK_PRIORITIES,
	TASK_STATUSES,
	TASK_TYPES,
	type TaskPriority,
	type TaskStatus,
	type TaskType
} from '#lib/shared/enums';
import { KEY_RE } from '../projects/validation';
import { isCalendarDate } from '../tasks/dates';
import { isUuid, SORT_DIRS, type AssigneeFilter, type SortDir } from '../tasks/validation';

/**
 * The Issues page's filters, sort and page (RB-12), read from the URL: the URL is the state, so a filter set is a
 * link and works without JavaScript. Pure. Unknown keys are ignored; an invalid or surplus value of a known key is
 * dropped and counted, so the page can say "Some filters were ignored" instead of failing. The same parser makes
 * the stored form of a saved Issues view (canonicalizeQuery), so a view never holds what the page would not accept.
 */

export const ISSUE_LIMITS = {
	pageSize: 50,
	pageMax: 200,
	/** The total is counted up to this many rows ("10,000+" beyond). */
	countCap: 10_001,
	labelsMax: 8,
	projectsMax: 6,
	dateMin: '2000-01-01',
	dateMax: '2100-12-31',
	/** Project labels the filter offers at most (team labels are at most 100 anyway). */
	projectLabelOptionsMax: 300,
	/** Reports one user may file per minute. */
	reportsPerMinute: 20
} as const;

export const ISSUE_SORTS = ['updated', 'created', 'priority', 'due'] as const;
export type IssueSort = (typeof ISSUE_SORTS)[number];

export type ReporterFilter = 'any' | 'me' | { userId: string };
export type MilestoneFilter = 'any' | 'none' | { id: string };

export interface IssueFilters {
	/** Empty: every type (as are all four ticked). */
	types: TaskType[];
	statuses: TaskStatus[];
	priorities: TaskPriority[];
	/** Label ids, project or team (OR inside the set). */
	labels: string[];
	assignee: AssigneeFilter;
	reporter: ReporterFilter;
	/** Project keys, upper case. */
	projects: string[];
	milestone: MilestoneFilter;
	createdFrom: string | null;
	createdTo: string | null;
	updatedFrom: string | null;
	updatedTo: string | null;
	/** Include archived projects' tasks. */
	archived: boolean;
}

export interface IssueParams {
	filters: IssueFilters;
	sort: { sort: IssueSort; dir: SortDir };
	page: number;
	/** How many given values were dropped (invalid or over a limit). */
	ignored: number;
}

type DateKey = 'created_from' | 'created_to' | 'updated_from' | 'updated_to';

export function parseIssueParams(params: URLSearchParams): IssueParams {
	let ignored = 0;
	/** Distinct values of a multi key that pass `ok`, mapped; the rest counted as ignored; at most `max`. */
	const many = (key: string, ok: (v: string) => boolean, map = (v: string) => v, max = 100) => {
		const out: string[] = [];
		for (const raw of params.getAll(key)) {
			if (!ok(raw)) {
				ignored += 1;
				continue;
			}
			const v = map(raw);
			if (out.includes(v)) continue;
			if (out.length >= max) ignored += 1;
			else out.push(v);
		}
		return out;
	};
	/** An enum multi key: all values chosen is the same as none (no filter). */
	const pick = <T extends string>(key: string, allowed: readonly T[]): T[] => {
		const kept = many(key, (v) => (allowed as readonly string[]).includes(v)) as T[];
		return kept.length === allowed.length ? [] : allowed.filter((v) => kept.includes(v));
	};
	/** A single-valued key: the first value, when `ok`; anything else counted as ignored. */
	const one = (key: string, ok: (v: string) => boolean): string | null => {
		const all = params.getAll(key);
		if (all.length === 0) return null;
		const v = all[0] ?? '';
		if (all.length > 1) ignored += all.length - 1;
		if (v === '') return null;
		if (!ok(v)) {
			ignored += 1;
			return null;
		}
		return v;
	};
	const lower = (v: string) => v.toLowerCase();

	const assigneeRaw = one('assignee', (v) => v === 'me' || v === 'none' || isUuid(v));
	const reporterRaw = one('reporter', (v) => v === 'me' || isUuid(v));
	const milestoneRaw = one('milestone', (v) => v === 'none' || isUuid(v));
	const date = (key: DateKey) =>
		one(key, (v) => isCalendarDate(v, ISSUE_LIMITS.dateMin, ISSUE_LIMITS.dateMax));
	const archived = one('archived', (v) => v === '1') === '1';
	const sort = (one('sort', (v) => (ISSUE_SORTS as readonly string[]).includes(v)) ??
		'updated') as IssueSort;
	const dir = (one('dir', (v) => (SORT_DIRS as readonly string[]).includes(v)) ??
		'desc') as SortDir;
	const pageRaw = params.get('page') ?? '';
	const pageNumber = /^\d{1,3}$/.test(pageRaw) ? Number(pageRaw) : 1;

	const filters: IssueFilters = {
		types: pick('type', TASK_TYPES),
		statuses: pick('status', TASK_STATUSES),
		priorities: pick('priority', TASK_PRIORITIES),
		labels: many('label', isUuid, lower, ISSUE_LIMITS.labelsMax),
		assignee:
			assigneeRaw === null
				? 'any'
				: assigneeRaw === 'me' || assigneeRaw === 'none'
					? assigneeRaw
					: { userId: lower(assigneeRaw) },
		reporter:
			reporterRaw === null ? 'any' : reporterRaw === 'me' ? 'me' : { userId: lower(reporterRaw) },
		projects: many(
			'project',
			(v) => KEY_RE.test(v.toUpperCase()),
			(v) => v.toUpperCase(),
			ISSUE_LIMITS.projectsMax
		),
		milestone:
			milestoneRaw === null
				? 'any'
				: milestoneRaw === 'none'
					? 'none'
					: { id: lower(milestoneRaw) },
		createdFrom: date('created_from'),
		createdTo: date('created_to'),
		updatedFrom: date('updated_from'),
		updatedTo: date('updated_to'),
		archived
	};
	return {
		filters,
		sort: { sort, dir },
		page: pageNumber >= 1 && pageNumber <= ISSUE_LIMITS.pageMax ? pageNumber : 1,
		ignored
	};
}

/** How many filter groups are active (the "Filters (N)" button). */
export function activeFilterCount(f: IssueFilters): number {
	return [
		f.types.length > 0,
		f.statuses.length > 0,
		f.priorities.length > 0,
		f.labels.length > 0,
		f.assignee !== 'any',
		f.reporter !== 'any',
		f.projects.length > 0,
		f.milestone !== 'any',
		f.createdFrom !== null || f.createdTo !== null,
		f.updatedFrom !== null || f.updatedTo !== null,
		f.archived
	].filter(Boolean).length;
}

/**
 * The filters and sort as a query string in a fixed key order (no `page`): the links that keep them, and the stored
 * form of a saved Issues view. The default sort (`updated`, `desc`) is left out.
 */
export function issueQuery(
	f: IssueFilters,
	sort: { sort: IssueSort; dir: SortDir } = { sort: 'updated', dir: 'desc' }
): URLSearchParams {
	const q = new URLSearchParams();
	for (const v of f.types) q.append('type', v);
	for (const v of f.statuses) q.append('status', v);
	for (const v of f.priorities) q.append('priority', v);
	for (const v of f.labels) q.append('label', v);
	if (f.assignee !== 'any')
		q.set('assignee', typeof f.assignee === 'string' ? f.assignee : f.assignee.userId);
	if (f.reporter !== 'any')
		q.set('reporter', typeof f.reporter === 'string' ? f.reporter : f.reporter.userId);
	for (const v of f.projects) q.append('project', v);
	if (f.milestone !== 'any') q.set('milestone', f.milestone === 'none' ? 'none' : f.milestone.id);
	if (f.createdFrom) q.set('created_from', f.createdFrom);
	if (f.createdTo) q.set('created_to', f.createdTo);
	if (f.updatedFrom) q.set('updated_from', f.updatedFrom);
	if (f.updatedTo) q.set('updated_to', f.updatedTo);
	if (f.archived) q.set('archived', '1');
	if (sort.sort !== 'updated') q.set('sort', sort.sort);
	if (sort.dir !== 'desc') q.set('dir', sort.dir);
	return q;
}

/** `YYYY-MM-DD` of the day after `date` (a calendar date; no time zone). */
export function nextDay(date: string): string {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
