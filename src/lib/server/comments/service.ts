import { COMMENT_PAGE_SIZE, type CommentView, type ThreadData } from '#lib/shared/comments';
import type { TargetKind } from '#lib/shared/enums';
import { extractMentionIds } from '#lib/shared/markdown';
import type { SessionUser } from '../auth/session';
import { overUserAttemptLimit, overUserMinuteLimit } from '../auth/throttle';
import { mentionNames } from '../auth/users';
import type { Db } from '../db';
import { liveTargetSql, resolveTarget } from '../targets/resolve';
import { newId } from '../util';
import { computeRecipients, type CommentNotificationKind } from './recipients';
import { COMMENT_LIMITS, parseCommentPage } from './validation';

/**
 * Comments on tasks and pages (RB-03 PRD › Server modules, Concurrency). Raw, parameterised SQL through D1 itself
 * (`db.$client`), as in RB-02: every guarded write is one statement whose WHERE re-checks what the read saw, and a
 * comment and its notifications go in one D1 batch (one transaction), so neither exists without the other. Whether
 * a guarded write applied is read from `RETURNING id`.
 */

export type Actor = Pick<SessionUser, 'id' | 'role'>;
export interface CommentTarget {
	kind: TargetKind;
	id: string;
}

export type CommentWrite =
	| { ok: true; id: string }
	| { ok: false; reason: 'not_found' | 'forbidden' | 'throttled' }
	| { ok: false; reason: 'conflict'; body: string; updatedAt: number };

const prep = (db: Db, query: string, ...params: unknown[]) =>
	db.$client.prepare(query).bind(...params);

/** One `comment-create` attempt against the per-minute and the 10-minute budget (both fail closed). */
async function overCommentLimit(db: Db, userId: string, at: number): Promise<boolean> {
	return (
		(await overUserMinuteLimit(db, userId, at, 'comment-create', COMMENT_LIMITS.perMinute)) ||
		(await overUserAttemptLimit(db, userId, at, 'comment-create', COMMENT_LIMITS.perWindow))
	);
}

/** The ids among `ids` that are active users: one query, ids bound once as JSON. */
async function activeUserIds(db: Db, ids: readonly (string | null | undefined)[]) {
	const wanted = [...new Set(ids.filter((id): id is string => !!id).map((id) => id.toLowerCase()))];
	if (wanted.length === 0) return new Set<string>();
	const { results } = await prep(
		db,
		`SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?1)) AND status = 'active'
		 LIMIT 100`,
		JSON.stringify(wanted.slice(0, 100))
	).all<{ id: string }>();
	return new Set(results.map((r) => r.id));
}

/**
 * The notification inserts for `recipients`, each written only while its comment is live (and, for an edit, still
 * at `updatedAt`, the version this edit stored), its recipient is an active user other than the actor, and that user
 * has never had a notification of this kind for this comment: a mention edited out and back in notifies once
 * (red team L1).
 */
function notificationStatements(
	db: Db,
	recipients: Map<string, CommentNotificationKind>,
	c: { id: string; actorId: string; target: CommentTarget; at: number; updatedAt?: number }
) {
	return [...recipients].map(([userId, kind]) =>
		prep(
			db,
			`INSERT INTO notifications (id, user_id, kind, actor_id, target_kind, target_id, comment_id, created_at, read_at)
			 SELECT ?1, u.id, ?3, ?4, ?5, ?6, ?7, ?8, NULL FROM users u
			 WHERE u.id = ?2 AND u.status = 'active' AND u.id <> ?4
			   AND EXISTS (SELECT 1 FROM comments c WHERE c.id = ?7 AND c.deleted_at IS NULL
			     AND (?9 IS NULL OR c.updated_at = ?9))
			   AND NOT EXISTS (SELECT 1 FROM notifications n
			     WHERE n.comment_id = ?7 AND n.user_id = u.id AND n.kind = ?3)`,
			newId(),
			userId,
			kind,
			c.actorId,
			c.target.kind,
			c.target.id,
			c.id,
			c.at,
			c.updatedAt ?? null
		)
	);
}

/**
 * A new comment by `actor` on `target`, with its notifications (mentions; for a task also the assignee and the
 * creator). Refused when the target is missing or deleted (nothing written, even if it goes between the read and the
 * write) or the actor is over the `comment-create` budget. The same body by the same author on the same target
 * within a few seconds answers with the existing comment (a double submit; best effort).
 */
export async function createComment(
	db: Db,
	actor: Actor,
	target: CommentTarget,
	body: string,
	at: number
): Promise<CommentWrite> {
	const resolved = await resolveTarget(db, target.kind, target.id);
	if (!resolved) return { ok: false, reason: 'not_found' };
	const duplicate = await prep(
		db,
		`SELECT id FROM comments WHERE target_kind = ?1 AND target_id = ?2 AND author_id = ?3 AND body = ?4
		   AND deleted_at IS NULL AND created_at >= ?5 ORDER BY created_at DESC LIMIT 1`,
		target.kind,
		target.id,
		actor.id,
		body,
		at - COMMENT_LIMITS.duplicateWindowMs
	).first<{ id: string }>();
	if (duplicate) return { ok: true, id: duplicate.id };
	if (await overCommentLimit(db, actor.id, at)) return { ok: false, reason: 'throttled' };

	const mentionIds = extractMentionIds(body);
	const assigneeId = target.kind === 'task' ? resolved.assigneeId : null;
	const creatorId = target.kind === 'task' ? resolved.creatorId : null;
	const recipients = computeRecipients({
		mentionIds,
		activeIds: await activeUserIds(db, [...mentionIds, assigneeId, creatorId]),
		assigneeId,
		creatorId,
		authorId: actor.id.toLowerCase()
	});
	const id = newId();
	const [inserted] = await db.$client.batch([
		prep(
			db,
			`INSERT INTO comments (id, target_kind, target_id, author_id, body, created_at, updated_at, deleted_at)
			 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6, NULL WHERE ${liveTargetSql(target.kind, '?3')}
			 RETURNING id`,
			id,
			target.kind,
			target.id,
			actor.id,
			body,
			at
		),
		...notificationStatements(db, recipients, { id, actorId: actor.id, target, at })
	]);
	return inserted?.results.length === 1 ? { ok: true, id } : { ok: false, reason: 'not_found' };
}

interface StoredComment {
	authorId: string;
	body: string;
	updatedAt: number;
	deletedAt: number | null;
}

/** The comment `id` on `target`, deleted or not; null when there is none (or it is on another target). */
function storedComment(db: Db, target: CommentTarget, id: string) {
	return prep(
		db,
		`SELECT author_id AS authorId, body, updated_at AS updatedAt, deleted_at AS deletedAt
		 FROM comments WHERE id = ?1 AND target_kind = ?2 AND target_id = ?3`,
		id,
		target.kind,
		target.id
	).first<StoredComment>();
}

/**
 * The author's edit of their own comment, against the version they edited (`expectedUpdatedAt`). Only users the
 * new body mentions and the old one did not are notified (`mention`); nothing else is sent on an edit, and removing
 * a mention deletes nothing. Refusals: `not_found` (missing, deleted, other target or target gone), `forbidden`
 * (not the author: admins cannot edit others' text), `throttled`, `conflict` (changed meanwhile; carries the stored
 * body and version).
 */
export async function editComment(
	db: Db,
	actor: Actor,
	target: CommentTarget,
	commentId: string,
	body: string,
	expectedUpdatedAt: number,
	at: number
): Promise<CommentWrite> {
	const stored = await storedComment(db, target, commentId);
	if (!stored || stored.deletedAt !== null) return { ok: false, reason: 'not_found' };
	if (stored.authorId !== actor.id) return { ok: false, reason: 'forbidden' };
	if (await overCommentLimit(db, actor.id, at)) return { ok: false, reason: 'throttled' };
	if (stored.updatedAt !== expectedUpdatedAt)
		return { ok: false, reason: 'conflict', body: stored.body, updatedAt: stored.updatedAt };
	if (stored.body === body) return { ok: true, id: commentId };

	const updatedAt = Math.max(at, expectedUpdatedAt + 1);
	const mentionIds = extractMentionIds(body);
	const recipients = computeRecipients({
		mentionIds,
		activeIds: await activeUserIds(db, mentionIds),
		authorId: actor.id.toLowerCase(),
		alreadyNotified: new Set(extractMentionIds(stored.body))
	});
	const [updated] = await db.$client.batch([
		prep(
			db,
			`UPDATE comments SET body = ?1, updated_at = ?2
			 WHERE id = ?3 AND author_id = ?4 AND target_kind = ?5 AND target_id = ?6 AND deleted_at IS NULL
			   AND updated_at = ?7 AND ${liveTargetSql(target.kind, '?6')}
			 RETURNING id`,
			body,
			updatedAt,
			commentId,
			actor.id,
			target.kind,
			target.id,
			expectedUpdatedAt
		),
		...notificationStatements(db, recipients, {
			id: commentId,
			actorId: actor.id,
			target,
			at,
			updatedAt
		})
	]);
	if (updated?.results.length === 1) return { ok: true, id: commentId };
	const now = await storedComment(db, target, commentId);
	if (!now || now.deletedAt !== null || !(await resolveTarget(db, target.kind, target.id)))
		return { ok: false, reason: 'not_found' };
	return { ok: false, reason: 'conflict', body: now.body, updatedAt: now.updatedAt };
}

/**
 * Soft-deletes a comment: its author or an admin. Idempotent (an already deleted comment answers ok). Its
 * notifications stay and read "comment deleted".
 */
export async function deleteComment(
	db: Db,
	actor: Actor,
	target: CommentTarget,
	commentId: string,
	at: number
): Promise<CommentWrite> {
	const admin = actor.role === 'admin';
	const deleted = await prep(
		db,
		`UPDATE comments SET deleted_at = ?1, updated_at = ?1
		 WHERE id = ?2 AND target_kind = ?3 AND target_id = ?4 AND deleted_at IS NULL AND (?5 = 1 OR author_id = ?6)
		 RETURNING id`,
		at,
		commentId,
		target.kind,
		target.id,
		admin ? 1 : 0,
		actor.id
	).all<{ id: string }>();
	if (deleted.results.length === 1) return { ok: true, id: commentId };
	const stored = await storedComment(db, target, commentId);
	if (!stored) return { ok: false, reason: 'not_found' };
	if (stored.deletedAt !== null) return { ok: true, id: commentId };
	return { ok: false, reason: 'forbidden' };
}

/** How many live comments of its thread come up to and including `commentId` (0 when it is not live). */
export async function commentPosition(db: Db, commentId: string): Promise<number> {
	const row = await prep(
		db,
		`SELECT count(*) AS n FROM comments c JOIN comments o
		   ON o.target_kind = c.target_kind AND o.target_id = c.target_id AND o.deleted_at IS NULL
		  AND (o.created_at < c.created_at OR (o.created_at = c.created_at AND o.id <= c.id))
		 WHERE c.id = ?1 AND c.deleted_at IS NULL`,
		commentId
	).first<{ n: number }>();
	return row?.n ?? 0;
}

/** The thread page (`?cpage=`) a comment at `position` is on. */
export const pageOfPosition = (position: number) =>
	Math.max(1, Math.ceil(position / COMMENT_PAGE_SIZE));

interface CommentRow {
	id: string;
	authorId: string;
	authorName: string;
	body: string;
	createdAt: number;
	updatedAt: number;
}

/** One page (COMMENT_PAGE_SIZE, oldest first) of a target's live comments, and how many there are in all. */
export async function listComments(
	db: Db,
	target: CommentTarget,
	page: number
): Promise<{ rows: CommentRow[]; total: number }> {
	const [rows, count] = await Promise.all([
		prep(
			db,
			`SELECT c.id, c.author_id AS authorId, u.name AS authorName, c.body, c.created_at AS createdAt,
				c.updated_at AS updatedAt
			 FROM comments c JOIN users u ON u.id = c.author_id
			 WHERE c.target_kind = ?1 AND c.target_id = ?2 AND c.deleted_at IS NULL
			 ORDER BY c.created_at, c.id LIMIT ?3 OFFSET ?4`,
			target.kind,
			target.id,
			COMMENT_PAGE_SIZE,
			(page - 1) * COMMENT_PAGE_SIZE
		).all<CommentRow>(),
		prep(
			db,
			`SELECT count(*) AS n FROM comments WHERE target_kind = ?1 AND target_id = ?2 AND deleted_at IS NULL`,
			target.kind,
			target.id
		).first<{ n: number }>()
	]);
	return { rows: rows.results, total: count?.n ?? 0 };
}

/**
 * Everything `CommentThread` needs for `target` as `viewer` sees it, on the page `url`'s `?cpage=` names (clamped
 * to the last page): the comments with the viewer's Edit/Delete rights (display only; the actions decide), the
 * mention names of every body shown, and the viewer's own comment opened by `?cedit=`.
 */
export async function loadThread(
	db: Db,
	viewer: Actor,
	target: CommentTarget,
	url: URL
): Promise<ThreadData> {
	let page = parseCommentPage(url.searchParams.get('cpage'));
	let { rows, total } = await listComments(db, target, page);
	const pageCount = Math.max(1, Math.ceil(total / COMMENT_PAGE_SIZE));
	if (page > pageCount) {
		page = pageCount;
		({ rows, total } = await listComments(db, target, page));
	}
	const names = await mentionNames(
		db,
		rows.flatMap((r) => extractMentionIds(r.body)),
		{ markDeactivated: true }
	);
	const comments: CommentView[] = rows.map((r) => ({
		...r,
		edited: r.updatedAt > r.createdAt,
		canEdit: r.authorId === viewer.id,
		canDelete: r.authorId === viewer.id || viewer.role === 'admin'
	}));
	const cedit = url.searchParams.get('cedit')?.toLowerCase() ?? null;
	const editingId = comments.find((c) => c.id === cedit && c.canEdit)?.id ?? null;
	return { target, comments, names, page, pageCount, total, editingId };
}
