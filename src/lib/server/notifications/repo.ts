import type { NotificationKind, TargetKind } from '#lib/shared/enums';
import { extractMentionIds } from '#lib/shared/markdown';
import { mentionNames } from '../auth/users';
import { pageOfPosition } from '../comments/service';
import type { Db } from '../db';
import { liveTargetSql, resolveTargets, targetKey } from '../targets/resolve';
import { commentExcerpt } from './excerpt';

/**
 * The in-app inbox (RB-03 PRD › Server modules). Every query is scoped `user_id = :me`, so another user's row
 * behaves exactly like a missing one. Raw, parameterised SQL through D1; lists are cursor-paginated on
 * (created_at, id) newest first, so rows with equal timestamps are neither repeated nor skipped.
 */

export const NOTIFICATIONS_PAGE_SIZE = 30;
/** The badge counts no further ("99+" past it). */
export const UNREAD_COUNT_CAP = 100;

export const NOTIFICATION_FILTERS = ['all', 'unread'] as const;
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number];

export interface Cursor {
	createdAt: number;
	id: string;
}

export const formatCursor = (c: Cursor) => `${c.createdAt}_${c.id}`;

/** `?before=<createdAt>_<id>`, or null for anything malformed (the list then starts at the newest row). */
export function parseCursor(raw: string | null | undefined): Cursor | null {
	const m = raw
		? /^([0-9]{1,15})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(raw)
		: null;
	return m ? { createdAt: Number(m[1]), id: (m[2] as string).toLowerCase() } : null;
}

/** `?filter=`: `unread`, else `all`. */
export const parseFilter = (raw: string | null | undefined): NotificationFilter =>
	raw === 'unread' ? 'unread' : 'all';

export interface NotificationRow {
	id: string;
	kind: NotificationKind;
	actorId: string;
	targetKind: TargetKind;
	targetId: string;
	commentId: string | null;
	createdAt: number;
	readAt: number | null;
}

const prep = (db: Db, query: string, ...params: unknown[]) =>
	db.$client.prepare(query).bind(...params);

/** One page of `userId`'s notifications, newest first, before `before`; `next` is the cursor of the page after. */
export async function listNotifications(
	db: Db,
	userId: string,
	options: { filter: NotificationFilter; before: Cursor | null; limit?: number }
): Promise<{ rows: NotificationRow[]; next: string | null }> {
	const limit = options.limit ?? NOTIFICATIONS_PAGE_SIZE;
	const { results } = await prep(
		db,
		`SELECT id, kind, actor_id AS actorId, target_kind AS targetKind, target_id AS targetId,
			comment_id AS commentId, created_at AS createdAt, read_at AS readAt
		 FROM notifications
		 WHERE user_id = ?1 AND (?2 = 0 OR read_at IS NULL)
		   AND (?3 IS NULL OR created_at < ?3 OR (created_at = ?3 AND id < ?4))
		 ORDER BY created_at DESC, id DESC LIMIT ?5`,
		userId,
		options.filter === 'unread' ? 1 : 0,
		options.before?.createdAt ?? null,
		options.before?.id ?? '',
		limit + 1
	).all<NotificationRow>();
	const rows = results.slice(0, limit);
	const last = rows.at(-1);
	return { rows, next: results.length > limit && last ? formatCursor(last) : null };
}

/** `userId`'s unread notifications, counted up to UNREAD_COUNT_CAP (one indexed scan). */
export async function unreadCount(db: Db, userId: string): Promise<number> {
	const row = await prep(
		db,
		`SELECT count(*) AS n FROM (SELECT 1 FROM notifications WHERE user_id = ?1 AND read_at IS NULL LIMIT ?2)`,
		userId,
		UNREAD_COUNT_CAP
	).first<{ n: number }>();
	return row?.n ?? 0;
}

/** Marks one of `userId`'s own notifications read; idempotent. False when it is not theirs, missing or read. */
export async function markRead(db: Db, userId: string, id: string, at: number): Promise<boolean> {
	const { results } = await prep(
		db,
		`UPDATE notifications SET read_at = ?1 WHERE id = ?2 AND user_id = ?3 AND read_at IS NULL RETURNING id`,
		at,
		id,
		userId
	).all<{ id: string }>();
	return results.length === 1;
}

/** Marks every unread notification of `userId` read in one statement; returns how many changed. */
export async function markAllRead(db: Db, userId: string, at: number): Promise<number> {
	const { results } = await prep(
		db,
		`UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND read_at IS NULL RETURNING id`,
		at,
		userId
	).all<{ id: string }>();
	return results.length;
}

/** One inbox row as the page shows it. Every text is plain text; `href` is a path on this site. */
export interface NotificationView {
	id: string;
	kind: NotificationKind;
	actorName: string;
	/** "mentioned you in a comment on", "commented on", "assigned you". */
	verb: string;
	/** Null when the task or page is gone ("This item is no longer available"). */
	targetTitle: string | null;
	href: string | null;
	excerpt: string | null;
	commentDeleted: boolean;
	createdAt: number;
	unread: boolean;
}

const VERBS: Record<NotificationKind, string> = {
	mention: 'mentioned you in a comment on',
	comment: 'commented on',
	assigned: 'assigned you'
};

const idsJson = (ids: (string | null)[]) =>
	JSON.stringify([...new Set(ids.filter((id): id is string => !!id))].slice(0, 500));

/**
 * The rows as the inbox shows them, with a fixed number of queries whatever their count: actors, live targets
 * (one per kind), comments (with their thread position, for the link's `?cpage=`) and the names of the users the
 * comment excerpts mention. A comment shows an excerpt only while it and its target (task or page, and its project)
 * are live: a row whose target is gone reads "no longer available" and carries no comment text (red team M1).
 */
export async function describeNotifications(
	db: Db,
	rows: readonly NotificationRow[]
): Promise<NotificationView[]> {
	if (rows.length === 0) return [];
	const [actors, targets, comments] = await Promise.all([
		prep(
			db,
			`SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?1)) LIMIT 500`,
			idsJson(rows.map((r) => r.actorId))
		)
			.all<{ id: string; name: string }>()
			.then((r) => new Map(r.results.map((u) => [u.id, u.name]))),
		resolveTargets(
			db,
			rows.map((r) => ({ kind: r.targetKind, id: r.targetId }))
		),
		// Only comments whose task or page (and its project) is live: a deleted target's comments show nothing.
		prep(
			db,
			`SELECT c.id, c.body, c.deleted_at AS deletedAt,
				(SELECT count(*) FROM comments o WHERE o.target_kind = c.target_kind AND o.target_id = c.target_id
				   AND o.deleted_at IS NULL
				   AND (o.created_at < c.created_at OR (o.created_at = c.created_at AND o.id <= c.id))) AS position
			 FROM comments c
			 WHERE c.id IN (SELECT value FROM json_each(?1))
			   AND ((c.target_kind = 'task' AND ${liveTargetSql('task', 'c.target_id')})
			     OR (c.target_kind = 'page' AND ${liveTargetSql('page', 'c.target_id')}))
			 LIMIT 500`,
			idsJson(rows.map((r) => r.commentId))
		)
			.all<{ id: string; body: string; deletedAt: number | null; position: number }>()
			.then((r) => new Map(r.results.map((c) => [c.id, c])))
	]);
	const names = await mentionNames(
		db,
		[...comments.values()]
			.filter((c) => c.deletedAt === null)
			.flatMap((c) => extractMentionIds(c.body)),
		{ markDeactivated: true }
	);
	return rows.map((r) => {
		const target = targets.get(targetKey(r.targetKind, r.targetId));
		// `comments` holds only comments of live targets; the target check here is the second line behind it.
		const comment = target && r.commentId ? comments.get(r.commentId) : undefined;
		const commentLive = comment !== undefined && comment.deletedAt === null;
		const page = commentLive ? pageOfPosition(comment.position) : 1;
		const href = target
			? `${target.href}${page > 1 ? `?cpage=${page}` : ''}${commentLive ? `#comment-${comment.id}` : ''}`
			: null;
		return {
			id: r.id,
			kind: r.kind,
			actorName: actors.get(r.actorId) ?? 'Someone',
			verb: VERBS[r.kind],
			targetTitle: target?.title ?? null,
			href,
			excerpt: commentLive ? commentExcerpt(comment.body, names) : null,
			commentDeleted: target !== undefined && r.commentId !== null && !commentLive,
			createdAt: r.createdAt,
			unread: r.readAt === null
		};
	});
}
