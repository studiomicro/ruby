import type { TargetKind } from '#lib/shared/enums';
import type { Db } from '../db';
import { formatTaskRef, taskPath } from '../tasks/format';

/**
 * What a comment, a notification or an attachment hangs on: a live task (in a live project) or a live page (team
 * page, or in a live project). Archived projects still count as live (RB-03 owner decision 3). Raw, parameterised
 * SQL through D1 itself; ids are bound once as JSON (`json_each`), never one parameter each.
 */
export interface Target {
	kind: TargetKind;
	id: string;
	/** What a person reads: `OPS-12 Fix login` for a task, the page title for a page. */
	title: string;
	/** `OPS-12` for a task. */
	ref?: string;
	href: string;
	assigneeId?: string | null;
	creatorId: string;
	projectKey?: string;
}

/** Most targets one lookup reads (a notifications page holds 30). */
const TARGETS_MAX = 500;

/**
 * SQL: the `kind` target whose id is the bound parameter `idParam` (`?3`) is live. Used as the guard of every
 * comment write, so a target deleted after the page was read takes nothing.
 */
export function liveTargetSql(kind: TargetKind, idParam: string): string {
	return kind === 'task'
		? `EXISTS (SELECT 1 FROM tasks lt JOIN projects lp ON lp.id = lt.project_id
			WHERE lt.id = ${idParam} AND lt.deleted_at IS NULL AND lp.deleted_at IS NULL)`
		: `EXISTS (SELECT 1 FROM pages lg LEFT JOIN projects lp ON lp.id = lg.project_id
			WHERE lg.id = ${idParam} AND lg.deleted_at IS NULL AND (lg.project_id IS NULL OR lp.deleted_at IS NULL))`;
}

export const targetKey = (kind: TargetKind, id: string) => `${kind}:${id}`;

/** The live targets among `refs`, keyed by `targetKey`: at most one query per kind, whatever the count. */
export async function resolveTargets(
	db: Db,
	refs: readonly { kind: TargetKind; id: string }[]
): Promise<Map<string, Target>> {
	const ids = (kind: TargetKind) =>
		JSON.stringify(
			[...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id))].slice(0, TARGETS_MAX)
		);
	const taskIds = ids('task');
	const pageIds = ids('page');
	const out = new Map<string, Target>();
	const [taskRows, pageRows] = await Promise.all([
		taskIds === '[]'
			? []
			: db.$client
					.prepare(
						`SELECT t.id, t.number, t.title, t.assignee_id AS assigneeId, t.created_by AS creatorId, p.key
						 FROM tasks t JOIN projects p ON p.id = t.project_id
						 WHERE t.id IN (SELECT value FROM json_each(?1)) AND t.deleted_at IS NULL AND p.deleted_at IS NULL
						 LIMIT ${TARGETS_MAX}`
					)
					.bind(taskIds)
					.all<{
						id: string;
						number: number;
						title: string;
						assigneeId: string | null;
						creatorId: string;
						key: string;
					}>()
					.then((r) => r.results),
		pageIds === '[]'
			? []
			: db.$client
					.prepare(
						`SELECT pg.id, pg.title, pg.created_by AS creatorId
						 FROM pages pg LEFT JOIN projects p ON p.id = pg.project_id
						 WHERE pg.id IN (SELECT value FROM json_each(?1)) AND pg.deleted_at IS NULL
						   AND (pg.project_id IS NULL OR p.deleted_at IS NULL)
						 LIMIT ${TARGETS_MAX}`
					)
					.bind(pageIds)
					.all<{ id: string; title: string; creatorId: string }>()
					.then((r) => r.results)
	]);
	for (const t of taskRows) {
		const ref = formatTaskRef(t.key, t.number);
		out.set(targetKey('task', t.id), {
			kind: 'task',
			id: t.id,
			title: `${ref} ${t.title}`,
			ref,
			href: taskPath(t.key, t.number),
			assigneeId: t.assigneeId,
			creatorId: t.creatorId,
			projectKey: t.key
		});
	}
	for (const p of pageRows)
		out.set(targetKey('page', p.id), {
			kind: 'page',
			id: p.id,
			title: p.title,
			href: `/kb/${p.id}`,
			creatorId: p.creatorId
		});
	return out;
}

/** The live target `kind`/`id`, or null when it is missing or soft-deleted (or its project is). */
export async function resolveTarget(db: Db, kind: TargetKind, id: string): Promise<Target | null> {
	return (await resolveTargets(db, [{ kind, id }])).get(targetKey(kind, id)) ?? null;
}
