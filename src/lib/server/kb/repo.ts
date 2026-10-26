import type { ProjectStatus } from '#lib/shared/enums';
import type { SessionUser } from '../auth/session';
import type { Db } from '../db';
import { isUniqueViolation, newId } from '../util';
import { deleteRefusal, type DeleteRefusal } from './permissions';
import { placePosition, type ScopeRow } from './tree';
import { KB_LIMITS, type Placement } from './validation';

/**
 * Knowledge-base data access (RB-02 PRD › Server modules, Concurrency). Raw, parameterised SQL through D1 itself
 * (`db.$client`): the tree needs recursive CTEs, and Drizzle's batch cannot carry a raw statement with parameters.
 * A guarded write says whether it applied through `RETURNING id`, not `meta.changes` (D1 counts the FTS trigger
 * rows there too). Every value is bound
 * (`?1`, `?2` …); no SQL is built from input. `pages_fts` is never written here: migration 0001's triggers keep it in
 * step with every insert and title/body update.
 *
 * Projects are read through this module's own small queries (no RB-01 import). A page counts as live when it and
 * its project (if any) are not soft-deleted.
 */

const prep = (db: Db, query: string, ...params: unknown[]) =>
	db.$client.prepare(query).bind(...params);

async function all<T>(db: Db, query: string, ...params: unknown[]): Promise<T[]> {
	return (await prep(db, query, ...params).all<T>()).results;
}

async function first<T>(db: Db, query: string, ...params: unknown[]): Promise<T | null> {
	return (await prep(db, query, ...params).first<T>()) ?? null;
}

/** `p` (a pages alias) is not in a soft-deleted project. */
const LIVE_SCOPE = `(p.project_id IS NULL OR EXISTS (SELECT 1 FROM projects lp WHERE lp.id = p.project_id AND lp.deleted_at IS NULL))`;

/** `?N` as a page and every live page below it (UNION, so even a corrupt cycle ends). */
const subtreeCte = (param: string) =>
	`sub(id) AS (SELECT ${param} UNION SELECT c.id FROM pages c JOIN sub ON c.parent_id = sub.id WHERE c.deleted_at IS NULL)`;

// ── Projects ────────────────────────────────────────────────────────────────────────────────────────────────

export interface ProjectRef {
	id: string;
	key: string;
	name: string;
	status: ProjectStatus;
}

const PROJECTS_MAX = 200;

/** A live (not deleted) project by key, archived included; null otherwise. */
export function getProjectByKey(db: Db, key: string): Promise<ProjectRef | null> {
	return first<ProjectRef>(
		db,
		`SELECT id, key, name, status FROM projects WHERE key = ?1 COLLATE NOCASE AND deleted_at IS NULL LIMIT 1`,
		key
	);
}

/** Live projects by name: active only for the scope switcher, archived too where a page may be moved. */
export function listActiveProjects(
	db: Db,
	options: { includeArchived?: boolean } = {}
): Promise<ProjectRef[]> {
	return all<ProjectRef>(
		db,
		`SELECT id, key, name, status FROM projects WHERE deleted_at IS NULL AND (?1 = 1 OR status = 'active')
		 ORDER BY name COLLATE NOCASE, key LIMIT ${PROJECTS_MAX}`,
		options.includeArchived ? 1 : 0
	);
}

// ── Reading pages ───────────────────────────────────────────────────────────────────────────────────────────

export interface PageDetail {
	id: string;
	projectId: string | null;
	parentId: string | null;
	title: string;
	body: string;
	revision: number;
	createdBy: string;
	createdByName: string;
	createdAt: number;
	/** Who saved the current revision, and when (a move changes neither). */
	editedByName: string | null;
	editedAt: number | null;
	project: ProjectRef | null;
}

interface PageDetailRow extends Omit<PageDetail, 'project'> {
	projectKey: string | null;
	projectName: string | null;
	projectStatus: ProjectStatus | null;
}

/** A live page with its names and project; null when missing, deleted or in a deleted project. */
export async function getPage(db: Db, id: string): Promise<PageDetail | null> {
	const row = await first<PageDetailRow>(
		db,
		`SELECT p.id, p.project_id AS projectId, p.parent_id AS parentId, p.title, p.body, p.revision,
			p.created_by AS createdBy, cu.name AS createdByName, p.created_at AS createdAt,
			eu.name AS editedByName, r.created_at AS editedAt,
			pr.key AS projectKey, pr.name AS projectName, pr.status AS projectStatus
		 FROM pages p
		 JOIN users cu ON cu.id = p.created_by
		 LEFT JOIN page_revisions r ON r.page_id = p.id AND r.revision = p.revision
		 LEFT JOIN users eu ON eu.id = r.edited_by
		 LEFT JOIN projects pr ON pr.id = p.project_id
		 WHERE p.id = ?1 AND p.deleted_at IS NULL AND (p.project_id IS NULL OR pr.deleted_at IS NULL)`,
		id
	);
	if (!row) return null;
	const { projectKey, projectName, projectStatus, ...page } = row;
	return {
		...page,
		project:
			page.projectId && projectKey && projectName && projectStatus
				? { id: page.projectId, key: projectKey, name: projectName, status: projectStatus }
				: null
	};
}

/**
 * One scope's live pages (`projectId` null: team-wide), ordered `(parent_id, position, title)`, at most
 * KB_LIMITS.scopeRowsMax. Past that, only the top three levels are loaded and a third-level page with children is
 * marked `more` (the tree links to it instead), and `truncated` is set.
 */
export async function listScopePages(
	db: Db,
	projectId: string | null
): Promise<{ rows: ScopeRow[]; truncated: boolean }> {
	const max = KB_LIMITS.scopeRowsMax;
	const rows = await all<ScopeRow>(
		db,
		`SELECT id, parent_id AS parentId, title, position FROM pages
		 WHERE project_id IS ?1 AND deleted_at IS NULL ORDER BY parent_id, position, title LIMIT ${max + 1}`,
		projectId
	);
	if (rows.length <= max) return { rows, truncated: false };
	const shallow = await all<Omit<ScopeRow, 'more'> & { more: number }>(
		db,
		`WITH RECURSIVE t(id, depth) AS (
			SELECT id, 1 FROM pages WHERE project_id IS ?1 AND parent_id IS NULL AND deleted_at IS NULL
			UNION ALL
			SELECT c.id, t.depth + 1 FROM pages c JOIN t ON c.parent_id = t.id WHERE c.deleted_at IS NULL AND t.depth < 3
		 )
		 SELECT p.id, p.parent_id AS parentId, p.title, p.position,
			(t.depth = 3 AND EXISTS (SELECT 1 FROM pages k WHERE k.parent_id = p.id AND k.deleted_at IS NULL)) AS more
		 FROM t JOIN pages p ON p.id = t.id ORDER BY p.parent_id, p.position, p.title LIMIT ${max}`,
		projectId
	);
	return { rows: shallow.map((r) => ({ ...r, more: r.more === 1 })), truncated: true };
}

/** The ancestors of a live page, top first (empty for a top-level page); bound by the depth limit. */
export function getBreadcrumbs(db: Db, id: string): Promise<{ id: string; title: string }[]> {
	return all<{ id: string; title: string }>(
		db,
		`WITH RECURSIVE anc(id, parent_id, title, depth) AS (
			SELECT id, parent_id, title, 0 FROM pages WHERE id = ?1 AND deleted_at IS NULL
			UNION ALL
			SELECT p.id, p.parent_id, p.title, anc.depth + 1 FROM pages p JOIN anc ON p.id = anc.parent_id
			WHERE p.deleted_at IS NULL AND anc.depth < ${KB_LIMITS.maxDepth + 2}
		 )
		 SELECT id, title FROM anc WHERE depth > 0 ORDER BY depth DESC`,
		id
	);
}

/** A page's live children in display order (at most KB_LIMITS.childrenMax). */
export function getChildren(db: Db, id: string): Promise<{ id: string; title: string }[]> {
	return all<{ id: string; title: string }>(
		db,
		`SELECT id, title FROM pages WHERE parent_id = ?1 AND deleted_at IS NULL
		 ORDER BY position, title, id LIMIT ${KB_LIMITS.childrenMax}`,
		id
	);
}

/** Depth of a live page (top level 1); 0 when it is not live. */
async function pageDepth(db: Db, id: string): Promise<number> {
	const row = await first<{ d: number | null }>(
		db,
		`WITH RECURSIVE anc(id, parent_id, depth) AS (
			SELECT id, parent_id, 1 FROM pages WHERE id = ?1 AND deleted_at IS NULL
			UNION ALL
			SELECT p.id, p.parent_id, anc.depth + 1 FROM pages p JOIN anc ON p.id = anc.parent_id
			WHERE anc.depth < 64
		 )
		 SELECT max(depth) AS d FROM anc`,
		id
	);
	return row?.d ?? 0;
}

/** Height of a page's live subtree (a leaf is 1) and how many pages it holds, the page included. */
export async function subtreeSize(db: Db, id: string): Promise<{ height: number; count: number }> {
	const row = await first<{ h: number | null; n: number }>(
		db,
		`WITH RECURSIVE sub(id, depth) AS (
			SELECT ?1, 1
			UNION
			SELECT c.id, sub.depth + 1 FROM pages c JOIN sub ON c.parent_id = sub.id
			WHERE c.deleted_at IS NULL AND sub.depth < 64
		 )
		 SELECT max(depth) AS h, count(DISTINCT id) AS n FROM sub`,
		id
	);
	return { height: row?.h ?? 1, count: row?.n ?? 1 };
}

// ── Creating ────────────────────────────────────────────────────────────────────────────────────────────────

export interface PageInput {
	title: string;
	body: string;
}

export type CreateResult =
	{ ok: true; id: string } | { ok: false; field: 'parent' | 'project'; error: string };

export const PARENT_GONE = 'That parent page no longer exists. Choose another.';
export const PARENT_OTHER_SCOPE = 'The parent page must be in the same space.';
export const PROJECT_GONE = 'That project no longer exists.';
export const TOO_DEEP = `Pages nest at most ${KB_LIMITS.maxDepth} levels deep. Choose a higher parent.`;

/**
 * A new page at the end of its siblings, plus its revision 1, in one batch. The insert is guarded (live parent in
 * the same scope, live project) and the revision row is copied from the inserted row, so either both exist or
 * neither does. The depth check is a pre-read (not race-safe; the worst case is one level too deep).
 */
export async function createPage(
	db: Db,
	actor: Pick<SessionUser, 'id'>,
	input: PageInput & { projectId: string | null; parentId: string | null },
	now: number
): Promise<CreateResult> {
	if (input.parentId) {
		const parent = await first<{ projectId: string | null }>(
			db,
			`SELECT project_id AS projectId FROM pages WHERE id = ?1 AND deleted_at IS NULL`,
			input.parentId
		);
		if (!parent) return { ok: false, field: 'parent', error: PARENT_GONE };
		if (parent.projectId !== input.projectId)
			return { ok: false, field: 'parent', error: PARENT_OTHER_SCOPE };
		if ((await pageDepth(db, input.parentId)) >= KB_LIMITS.maxDepth)
			return { ok: false, field: 'parent', error: TOO_DEEP };
	}
	const id = newId();
	const [inserted] = await db.$client.batch([
		prep(
			db,
			`INSERT INTO pages (id, project_id, parent_id, title, body, position, revision, created_by, updated_by, created_at, updated_at)
			 SELECT ?1, ?2, ?3, ?4, ?5,
				coalesce((SELECT max(position) FROM pages WHERE project_id IS ?2 AND parent_id IS ?3 AND deleted_at IS NULL), 0) + 1024,
				1, ?6, ?6, ?7, ?7
			 WHERE (?3 IS NULL OR EXISTS (SELECT 1 FROM pages WHERE id = ?3 AND deleted_at IS NULL AND project_id IS ?2))
			   AND (?2 IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = ?2 AND deleted_at IS NULL))
			 RETURNING id`,
			id,
			input.projectId,
			input.parentId,
			input.title,
			input.body,
			actor.id,
			now
		),
		prep(
			db,
			`INSERT INTO page_revisions (id, page_id, revision, title, body, edited_by, created_at)
			 SELECT ?1, id, revision, title, body, updated_by, updated_at FROM pages WHERE id = ?2`,
			newId(),
			id
		)
	]);
	if (inserted?.results.length === 1) return { ok: true, id };
	return input.parentId
		? { ok: false, field: 'parent', error: PARENT_GONE }
		: { ok: false, field: 'project', error: PROJECT_GONE };
}

// ── Saving and restoring ────────────────────────────────────────────────────────────────────────────────────

export interface CurrentVersion {
	revision: number;
	title: string;
	body: string;
	editedByName: string | null;
}

export type SaveResult =
	| { kind: 'saved'; revision: number }
	| { kind: 'unchanged'; revision: number }
	| { kind: 'not-found' }
	| { kind: 'conflict'; current: CurrentVersion };

function currentVersion(db: Db, id: string): Promise<CurrentVersion | null> {
	return first<CurrentVersion>(
		db,
		`SELECT p.revision, p.title, p.body, u.name AS editedByName
		 FROM pages p
		 LEFT JOIN page_revisions r ON r.page_id = p.id AND r.revision = p.revision
		 LEFT JOIN users u ON u.id = r.edited_by
		 WHERE p.id = ?1 AND p.deleted_at IS NULL AND ${LIVE_SCOPE}`,
		id
	);
}

/** After a refused save: gone (deleted meanwhile) or a conflict with what is there now. */
async function refusedSave(db: Db, id: string): Promise<SaveResult> {
	const current = await currentVersion(db, id);
	return current ? { kind: 'conflict', current } : { kind: 'not-found' };
}

/**
 * Saves a new title and body made from `expectedRevision`. Unchanged content writes nothing. Otherwise one batch:
 * the page update, guarded by `revision = expected`, and the revision row copied from the row that update wrote
 * (matched by revision, editor and timestamp). A save that lost a race changes no row, or collides on
 * `page_revisions_page_revision_uq` and rolls the whole batch back; both answer `conflict` with the current
 * version. A revision row never exists without its page update, so revisions stay contiguous 1..N.
 */
export async function savePage(
	db: Db,
	actor: Pick<SessionUser, 'id'>,
	id: string,
	input: PageInput,
	expectedRevision: number,
	now: number
): Promise<SaveResult> {
	const current = await currentVersion(db, id);
	if (!current) return { kind: 'not-found' };
	if (current.title === input.title && current.body === input.body)
		return { kind: 'unchanged', revision: current.revision };
	if (current.revision !== expectedRevision) return { kind: 'conflict', current };
	let updated: D1Result | undefined;
	try {
		[updated] = await db.$client.batch([
			prep(
				db,
				`UPDATE pages SET title = ?1, body = ?2, revision = revision + 1, updated_by = ?3, updated_at = ?4
				 WHERE id = ?5 AND revision = ?6 AND deleted_at IS NULL RETURNING id`,
				input.title,
				input.body,
				actor.id,
				now,
				id,
				expectedRevision
			),
			prep(
				db,
				`INSERT INTO page_revisions (id, page_id, revision, title, body, edited_by, created_at)
				 SELECT ?1, id, revision, title, body, updated_by, updated_at FROM pages
				 WHERE id = ?2 AND revision = ?3 + 1 AND updated_by = ?4 AND updated_at = ?5`,
				newId(),
				id,
				expectedRevision,
				actor.id,
				now
			)
		]);
	} catch (e) {
		if (isUniqueViolation(e)) return refusedSave(db, id);
		throw e;
	}
	if (updated?.results.length !== 1) return refusedSave(db, id);
	return { kind: 'saved', revision: expectedRevision + 1 };
}

export interface RevisionRow {
	revision: number;
	title: string;
	editedByName: string;
	createdAt: number;
}

/** One page of a page's revisions, newest first (KB_LIMITS.historyPageSize per page, `pageNo` from 1). */
export function listRevisions(db: Db, pageId: string, pageNo: number): Promise<RevisionRow[]> {
	const size = KB_LIMITS.historyPageSize;
	return all<RevisionRow>(
		db,
		`SELECT r.revision, r.title, u.name AS editedByName, r.created_at AS createdAt
		 FROM page_revisions r JOIN users u ON u.id = r.edited_by
		 WHERE r.page_id = ?1 ORDER BY r.revision DESC LIMIT ${size} OFFSET ?2`,
		pageId,
		(pageNo - 1) * size
	);
}

/** One revision of a page (the caller has checked the page is live); null when that page has no such revision. */
export function getRevision(
	db: Db,
	pageId: string,
	revision: number
): Promise<(RevisionRow & { body: string }) | null> {
	return first<RevisionRow & { body: string }>(
		db,
		`SELECT r.revision, r.title, r.body, u.name AS editedByName, r.created_at AS createdAt
		 FROM page_revisions r JOIN users u ON u.id = r.edited_by
		 WHERE r.page_id = ?1 AND r.revision = ?2`,
		pageId,
		revision
	);
}

/**
 * Restores revision `revision` as a new revision (history is never rewritten): the same guarded save, with that
 * revision's title and body, against the revision the form was rendered at.
 */
export async function restoreRevision(
	db: Db,
	actor: Pick<SessionUser, 'id'>,
	pageId: string,
	revision: number,
	expectedRevision: number,
	now: number
): Promise<SaveResult> {
	const old = await getRevision(db, pageId, revision);
	if (!old) return { kind: 'not-found' };
	return savePage(db, actor, pageId, { title: old.title, body: old.body }, expectedRevision, now);
}

// ── Moving ──────────────────────────────────────────────────────────────────────────────────────────────────

export type MoveResult =
	| { kind: 'moved' }
	| { kind: 'not-found' }
	| { kind: 'invalid'; field: 'parent' | 'placement' | 'project'; error: string };

export const MOVE_UNDER_SELF = 'A page cannot move under itself or one of its subpages.';
export const SIBLING_MISSING = 'That page is not under the chosen parent.';
export const MOVE_RACED = 'The pages changed meanwhile. Review and try again.';

interface SiblingRow {
	id: string;
	position: number;
}

function siblingsOf(
	db: Db,
	projectId: string | null,
	parentId: string | null,
	exceptId: string
): Promise<SiblingRow[]> {
	return all<SiblingRow>(
		db,
		`SELECT id, position FROM pages
		 WHERE project_id IS ?1 AND parent_id IS ?2 AND deleted_at IS NULL AND id <> ?3
		 ORDER BY position, title, id LIMIT ${KB_LIMITS.scopeRowsMax}`,
		projectId,
		parentId,
		exceptId
	);
}

/** Spreads one parent's children out again (1024, 2048 …) in their current order. Order is kept, so it is safe alone. */
async function renumberSiblings(db: Db, projectId: string | null, parentId: string | null) {
	await prep(
		db,
		`UPDATE pages SET position = r.rn * 1024
		 FROM (SELECT id, row_number() OVER (ORDER BY position, title, id) AS rn FROM pages
			   WHERE project_id IS ?1 AND parent_id IS ?2 AND deleted_at IS NULL) AS r
		 WHERE pages.id = r.id`,
		projectId,
		parentId
	).run();
}

/**
 * Moves a page (with its subtree) under `parentId` (null: the top level) of scope `projectId` (null: team), at
 * `placement` among the new siblings. Pre-reads give field errors; the UPDATE itself re-checks every rule (live
 * page, live parent in the target scope, the parent not in the page's own subtree, live project, and the parent's
 * depth plus the subtree's height within KB_LIMITS.maxDepth), so a forged, stale or racing move changes nothing. A scope change moves the whole subtree's `project_id` in the same batch. A move never
 * touches `revision`, so it never conflicts with an open editor.
 */
export async function movePage(
	db: Db,
	actor: Pick<SessionUser, 'id'>,
	id: string,
	target: { parentId: string | null; projectId: string | null; placement: Placement },
	now: number
): Promise<MoveResult> {
	const page = await first<{ projectId: string | null }>(
		db,
		`SELECT project_id AS projectId FROM pages p WHERE id = ?1 AND deleted_at IS NULL AND ${LIVE_SCOPE}`,
		id
	);
	if (!page) return { kind: 'not-found' };
	const { parentId, projectId, placement } = target;
	if (projectId) {
		const project = await first<{ id: string }>(
			db,
			`SELECT id FROM projects WHERE id = ?1 AND deleted_at IS NULL`,
			projectId
		);
		if (!project) return { kind: 'invalid', field: 'project', error: PROJECT_GONE };
	}
	if (parentId) {
		if (parentId === id) return { kind: 'invalid', field: 'parent', error: MOVE_UNDER_SELF };
		const parent = await first<{ projectId: string | null; inSubtree: number }>(
			db,
			`WITH RECURSIVE ${subtreeCte('?1')}
			 SELECT project_id AS projectId, EXISTS (SELECT 1 FROM sub WHERE sub.id = ?2) AS inSubtree
			 FROM pages WHERE id = ?2 AND deleted_at IS NULL`,
			id,
			parentId
		);
		if (!parent) return { kind: 'invalid', field: 'parent', error: PARENT_GONE };
		if (parent.inSubtree === 1) return { kind: 'invalid', field: 'parent', error: MOVE_UNDER_SELF };
		if (parent.projectId !== projectId)
			return { kind: 'invalid', field: 'parent', error: PARENT_OTHER_SCOPE };
		const [depth, size] = await Promise.all([pageDepth(db, parentId), subtreeSize(db, id)]);
		if (depth + size.height > KB_LIMITS.maxDepth)
			return { kind: 'invalid', field: 'parent', error: TOO_DEEP };
	}

	let siblings = await siblingsOf(db, projectId, parentId, id);
	let position = placePosition(siblings, placement);
	if (position === 'renumber') {
		await renumberSiblings(db, projectId, parentId);
		siblings = await siblingsOf(db, projectId, parentId, id);
		position = placePosition(siblings, placement);
	}
	if (position === 'missing-sibling' || position === 'renumber')
		return { kind: 'invalid', field: 'placement', error: SIBLING_MISSING };

	const statements = [
		prep(
			db,
			`UPDATE pages SET parent_id = ?2, project_id = ?3, position = ?4, updated_at = ?5, updated_by = ?6
			 WHERE id = ?1 AND deleted_at IS NULL
			   AND NOT EXISTS (WITH RECURSIVE ${subtreeCte('?1')} SELECT 1 FROM sub WHERE sub.id = ?2)
			   AND (?2 IS NULL OR EXISTS (SELECT 1 FROM pages WHERE id = ?2 AND deleted_at IS NULL AND project_id IS ?3))
			   AND (?3 IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = ?3 AND deleted_at IS NULL))
			   AND (?2 IS NULL OR
				 (WITH RECURSIVE anc(id, parent_id, d) AS (
					SELECT id, parent_id, 1 FROM pages WHERE id = ?2
					UNION ALL
					SELECT a.id, a.parent_id, anc.d + 1 FROM pages a JOIN anc ON a.id = anc.parent_id WHERE anc.d < 64
				  ) SELECT max(d) FROM anc)
				 + (WITH RECURSIVE h(id, d) AS (
					SELECT ?1, 1
					UNION
					SELECT c.id, h.d + 1 FROM pages c JOIN h ON c.parent_id = h.id WHERE c.deleted_at IS NULL AND h.d < 64
				  ) SELECT max(d) FROM h) <= ?7)
			 RETURNING id`,
			id,
			parentId,
			projectId,
			position,
			now,
			actor.id,
			KB_LIMITS.maxDepth
		)
	];
	if (page.projectId !== projectId)
		statements.push(
			prep(
				db,
				`WITH RECURSIVE ${subtreeCte('?1')}
				 UPDATE pages SET project_id = ?2
				 WHERE id IN (SELECT id FROM sub) AND id <> ?1 AND project_id IS NOT ?2
				   AND (SELECT project_id FROM pages WHERE id = ?1) IS ?2`,
				id,
				projectId
			)
		);
	const [moved] = await db.$client.batch(statements);
	if (moved?.results.length === 1) return { kind: 'moved' };
	const still = await first<{ id: string }>(
		db,
		`SELECT id FROM pages WHERE id = ?1 AND deleted_at IS NULL`,
		id
	);
	if (!still) return { kind: 'not-found' };
	// A move that raced another one: say "too deep" when that is now why it was refused.
	if (parentId) {
		const [depth, size] = await Promise.all([pageDepth(db, parentId), subtreeSize(db, id)]);
		if (depth + size.height > KB_LIMITS.maxDepth)
			return { kind: 'invalid', field: 'parent', error: TOO_DEEP };
	}
	return { kind: 'invalid', field: 'parent', error: MOVE_RACED };
}

// ── Deleting ────────────────────────────────────────────────────────────────────────────────────────────────

export type DeleteResult =
	| { kind: 'deleted'; count: number; projectKey: string | null }
	| { kind: 'not-found' }
	| { kind: 'forbidden'; reason: DeleteRefusal };

/** Live pages in `id`'s subtree (the page included) created by someone other than `userId`. */
export async function othersInSubtree(db: Db, id: string, userId: string): Promise<number> {
	const row = await first<{ n: number }>(
		db,
		`WITH RECURSIVE ${subtreeCte('?1')}
		 SELECT count(*) AS n FROM pages p WHERE p.id IN (SELECT id FROM sub) AND p.deleted_at IS NULL AND p.created_by <> ?2`,
		id,
		userId
	);
	return row?.n ?? 0;
}

/**
 * Soft-deletes a page and its whole live subtree in one statement (idempotent), recording who did it
 * (`updated_by`). An admin may delete any subtree; anyone else only one whose live pages they all created
 * (deleteRefusal). That rule is part of the UPDATE itself, so a page moved into the subtree while the delete runs
 * cannot be swept away with it. Search drops the rows through its `deleted_at IS NULL` join filter.
 */
export async function deletePage(
	db: Db,
	actor: Pick<SessionUser, 'id' | 'role'>,
	id: string,
	now: number
): Promise<DeleteResult> {
	const page = await getPage(db, id);
	if (!page) return { kind: 'not-found' };
	const isAdmin = actor.role === 'admin';
	const early = deleteRefusal(actor, page, 0);
	if (early) return { kind: 'forbidden', reason: early };
	const result = await prep(
		db,
		`WITH RECURSIVE ${subtreeCte('?1')}
		 UPDATE pages SET deleted_at = ?2, updated_at = ?2, updated_by = ?3
		 WHERE id IN (SELECT id FROM sub) AND deleted_at IS NULL
		   AND (?4 = 1 OR NOT EXISTS (
			 SELECT 1 FROM pages o WHERE o.id IN (SELECT id FROM sub) AND o.deleted_at IS NULL AND o.created_by <> ?3
		   ))
		 RETURNING id`,
		id,
		now,
		actor.id,
		isAdmin ? 1 : 0
	).all();
	if (result.results.length > 0)
		return { kind: 'deleted', count: result.results.length, projectKey: page.project?.key ?? null };
	const refusal = isAdmin
		? null
		: deleteRefusal(actor, page, await othersInSubtree(db, id, actor.id));
	return refusal ? { kind: 'forbidden', reason: refusal } : { kind: 'not-found' };
}
