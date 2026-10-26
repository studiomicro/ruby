import type { ProjectStatus, TaskStatus, TaskType } from '#lib/shared/enums';
import type { Db } from '../db';
import {
	buildMatchQuery,
	parseTaskRef,
	splitMarkedSnippet,
	type SearchType,
	type Segment
} from './query';

/**
 * Full-text search over pages and tasks (RB-02 PRD › Search): bounded top-N per type through `pages_fts` and
 * `tasks_fts`, joined to the base tables so soft-deleted rows (still in the index) and rows of deleted projects never
 * show. The MATCH expression comes only from buildMatchQuery; every value is bound. Results from archived projects
 * are kept and marked (owner decision 5).
 */

/**
 * Search budgets per user (RB-02 PRD: 30 a minute): 30 in any one-minute window and 300 per 10-minute window, each
 * counted on its own, so a burst cannot spend a whole 10 minutes at once. Only a query that runs counts; an empty or
 * token-less one does not.
 */
export const SEARCH_MINUTE_MAX = 30;
export const SEARCH_THROTTLE_MAX = 300;
export const TOO_MANY_SEARCHES = 'Too many searches, wait a moment.';

/** Rows per type when both are shown, and for a single type. Hard caps: no offset paging. */
export const SEARCH_MAX = { all: 25, single: 50 } as const;

export interface PageHit {
	id: string;
	title: Segment[];
	snippet: Segment[];
	projectKey: string | null;
	archived: boolean;
	updatedAt: number;
}

export interface TaskHit {
	id: string;
	key: string;
	number: number;
	title: Segment[];
	snippet: Segment[];
	status: TaskStatus;
	/** RB-12: the task's type (a badge next to the hit). */
	type: TaskType;
	archived: boolean;
	updatedAt: number;
}

export interface SearchResults {
	pages: PageHit[];
	tasks: TaskHit[];
	/** The task an identifier query (`OPS-12`) names, when it exists. */
	exact: TaskHit | null;
	/** Rows asked for per type (the page says "Showing top N"). */
	limit: number;
}

interface RawHit {
	id: string;
	title: string;
	snip: string;
	updatedAt: number;
	projectStatus: ProjectStatus | null;
}

const toSegments = (title: string, snip: string) => ({
	title: splitMarkedSnippet(title),
	snippet: splitMarkedSnippet(snip)
});

const TASK_COLUMNS = `t.id, pr.key AS key, t.number, t.status, t.type, t.updated_at AS updatedAt, pr.status AS projectStatus`;

/**
 * Pages and tasks matching `rawQuery` (empty results when it has no letter or digit). `type` limits the search to
 * one kind and raises its cap to SEARCH_MAX.single. An FTS error is thrown to the caller, which logs its class only.
 */
export async function searchAll(
	db: Db,
	rawQuery: string,
	options: { type: SearchType }
): Promise<SearchResults> {
	const limit = options.type === 'all' ? SEARCH_MAX.all : SEARCH_MAX.single;
	const match = buildMatchQuery(rawQuery);
	if (!match) return { pages: [], tasks: [], exact: null, limit };
	const d1 = db.$client;
	const [pageRows, taskRows] = await Promise.all([
		options.type === 'tasks'
			? []
			: d1
					.prepare(
						`SELECT p.id, highlight(pages_fts, 0, char(1), char(2)) AS title,
							snippet(pages_fts, 1, char(1), char(2), '…', 12) AS snip,
							p.updated_at AS updatedAt, pr.key AS projectKey, pr.status AS projectStatus
						 FROM pages_fts
						 JOIN pages p ON p.rowid = pages_fts.rowid
						 LEFT JOIN projects pr ON pr.id = p.project_id
						 WHERE pages_fts MATCH ?1 AND p.deleted_at IS NULL
						   AND (p.project_id IS NULL OR pr.deleted_at IS NULL)
						 ORDER BY bm25(pages_fts, 4.0, 1.0) LIMIT ?2`
					)
					.bind(match, limit)
					.all<RawHit & { projectKey: string | null }>()
					.then((r) => r.results),
		options.type === 'pages'
			? []
			: d1
					.prepare(
						`SELECT ${TASK_COLUMNS}, highlight(tasks_fts, 0, char(1), char(2)) AS title,
							snippet(tasks_fts, 1, char(1), char(2), '…', 12) AS snip
						 FROM tasks_fts
						 JOIN tasks t ON t.rowid = tasks_fts.rowid
						 JOIN projects pr ON pr.id = t.project_id
						 WHERE tasks_fts MATCH ?1 AND t.deleted_at IS NULL AND pr.deleted_at IS NULL
						 ORDER BY bm25(tasks_fts, 4.0, 1.0) LIMIT ?2`
					)
					.bind(match, limit)
					.all<RawHit & { key: string; number: number; status: TaskStatus; type: TaskType }>()
					.then((r) => r.results)
	]);

	const toTask = (
		r: RawHit & { key: string; number: number; status: TaskStatus; type: TaskType }
	): TaskHit => ({
		id: r.id,
		key: r.key,
		number: r.number,
		status: r.status,
		type: r.type,
		archived: r.projectStatus === 'archived',
		updatedAt: r.updatedAt,
		...toSegments(r.title, r.snip)
	});

	let exact: TaskHit | null = null;
	const ref = options.type === 'pages' ? null : parseTaskRef(rawQuery.trim());
	if (ref) {
		const row = await d1
			.prepare(
				`SELECT ${TASK_COLUMNS}, t.title, '' AS snip
				 FROM tasks t JOIN projects pr ON pr.id = t.project_id
				 WHERE pr.key = ?1 COLLATE NOCASE AND t.number = ?2 AND t.deleted_at IS NULL AND pr.deleted_at IS NULL
				 LIMIT 1`
			)
			.bind(ref.key, ref.number)
			.first<RawHit & { key: string; number: number; status: TaskStatus; type: TaskType }>();
		if (row) exact = toTask(row);
	}

	return {
		pages: pageRows.map((r) => ({
			id: r.id,
			projectKey: r.projectKey,
			archived: r.projectStatus === 'archived',
			updatedAt: r.updatedAt,
			...toSegments(r.title, r.snip)
		})),
		tasks: taskRows.map(toTask).filter((t) => t.id !== exact?.id),
		exact,
		limit
	};
}
