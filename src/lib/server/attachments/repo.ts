import type { Db } from '../db';
import { TARGET_LIVE_SQL } from './target';
import { ATTACHMENT_LIMITS } from '#lib/shared/attachments';
import type { TargetKind } from '#lib/shared/enums';

/**
 * Attachment metadata in D1 (bytes live in R2 under `r2_key`). Guarded writes report whether they applied through
 * `RETURNING id`, as kb/repo.ts does. `r2_key` never leaves the server.
 */

export interface AttachmentRow {
	id: string;
	targetKind: TargetKind;
	targetId: string;
	r2Key: string;
	filename: string;
	contentType: string;
	sizeBytes: number;
	uploadedBy: string;
	createdAt: number;
	deletedAt: number | null;
}

export interface AttachmentListItem {
	id: string;
	filename: string;
	contentType: string;
	sizeBytes: number;
	uploadedBy: string;
	uploaderName: string;
	createdAt: number;
}

const COLUMNS = `id, target_kind AS targetKind, target_id AS targetId, r2_key AS r2Key, filename,
	content_type AS contentType, size_bytes AS sizeBytes, uploaded_by AS uploadedBy, created_at AS createdAt,
	deleted_at AS deletedAt`;

/** The live attachments of one task or page, oldest first (at most maxPerTarget exist; the cap bounds the scan). */
export async function listAttachments(
	db: Db,
	kind: TargetKind,
	id: string
): Promise<AttachmentListItem[]> {
	const { results } = await db.$client
		.prepare(
			`SELECT a.id AS id, a.filename AS filename, a.content_type AS contentType, a.size_bytes AS sizeBytes,
				a.uploaded_by AS uploadedBy, COALESCE(u.name, '') AS uploaderName, a.created_at AS createdAt
			 FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
			 WHERE a.target_kind = ?1 AND a.target_id = ?2 AND a.deleted_at IS NULL
			 ORDER BY a.created_at, a.id LIMIT ?3`
		)
		.bind(kind, id, ATTACHMENT_LIMITS.maxPerTarget * 2)
		.all<AttachmentListItem>();
	return results;
}

/** One attachment row by id, tombstoned or not (callers decide what a tombstone means). */
export async function getAttachment(db: Db, id: string): Promise<AttachmentRow | null> {
	return (
		(await db.$client
			.prepare(`SELECT ${COLUMNS} FROM attachments WHERE id = ?1 LIMIT 1`)
			.bind(id)
			.first<AttachmentRow>()) ?? null
	);
}

/** Live attachments on one target. */
export async function countLive(db: Db, kind: TargetKind, id: string): Promise<number> {
	const row = await db.$client
		.prepare(
			`SELECT count(*) AS n FROM attachments WHERE target_kind = ?1 AND target_id = ?2 AND deleted_at IS NULL`
		)
		.bind(kind, id)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/**
 * Inserts the row only while the target is live, has fewer than maxPerTarget live attachments and the uploader is
 * still an active user, in one statement: concurrent uploads cannot pass the cap, and a target deleted (or an
 * uploader deactivated) while the body streamed gets nothing. True when written.
 */
export async function insertAttachmentGuarded(
	db: Db,
	row: Omit<AttachmentRow, 'deletedAt'>
): Promise<boolean> {
	const written = await db.$client
		.prepare(
			`INSERT INTO attachments
				(id, target_kind, target_id, r2_key, filename, content_type, size_bytes, uploaded_by, created_at)
			 SELECT ?3, ?1, ?2, ?4, ?5, ?6, ?7, ?8, ?9
			 WHERE (SELECT count(*) FROM attachments
					WHERE target_kind = ?1 AND target_id = ?2 AND deleted_at IS NULL) < ?10
				AND ${TARGET_LIVE_SQL}
				AND EXISTS (SELECT 1 FROM users WHERE id = ?8 AND status = 'active')
			 RETURNING id`
		)
		.bind(
			row.targetKind,
			row.targetId,
			row.id,
			row.r2Key,
			row.filename,
			row.contentType,
			row.sizeBytes,
			row.uploadedBy,
			row.createdAt,
			ATTACHMENT_LIMITS.maxPerTarget
		)
		.first<{ id: string }>();
	return written !== null;
}

/** Sets `deleted_at` on a live row; true when this call tombstoned it (false: already deleted or unknown). */
export async function tombstoneAttachment(db: Db, id: string, now: number): Promise<boolean> {
	const done = await db.$client
		.prepare(
			`UPDATE attachments SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL RETURNING id`
		)
		.bind(id, now)
		.first<{ id: string }>();
	return done !== null;
}

/** Whether `userId` is an active account right now (an upload can stream for minutes). */
export async function isActiveUser(db: Db, userId: string): Promise<boolean> {
	const row = await db.$client
		.prepare(`SELECT 1 AS ok FROM users WHERE id = ?1 AND status = 'active' LIMIT 1`)
		.bind(userId)
		.first<{ ok: number }>();
	return row !== null;
}
