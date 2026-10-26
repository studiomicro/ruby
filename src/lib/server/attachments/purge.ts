import type { Db } from '../db';
import { errorLabel } from '../util';

/**
 * The retention sweep for files whose task, page or project has been soft-deleted for PURGE_AFTER_DAYS or more
 * (orchestrator decision, SECURITY_REPORT L5). Until then such files stay undownloadable (every download re-checks
 * the parent) and come back with a restore. A run tombstones a bounded batch of rows in one guarded statement, which
 * re-checks the rule at write time, then deletes their R2 objects. Run by an admin from /admin/attachments
 * (docs/RUNBOOK.md › Attachment retention).
 */

export const PURGE_AFTER_DAYS = 30;
const PURGE_AFTER_MS = PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000;
/** Rows per run (R2 deletes up to 1000 keys per call; this keeps one request short). */
export const PURGE_BATCH = 100;
/** The count shown is capped: it only has to say "there is work". */
const COUNT_CAP = 1000;

/** Live attachments whose parent (or the parent's project) was deleted at or before `?1`. */
const PURGEABLE = `a.deleted_at IS NULL AND (
	(a.target_kind = 'task' AND EXISTS (
		SELECT 1 FROM tasks t JOIN projects pr ON pr.id = t.project_id
		WHERE t.id = a.target_id AND (t.deleted_at <= ?1 OR pr.deleted_at <= ?1)))
	OR (a.target_kind = 'page' AND EXISTS (
		SELECT 1 FROM pages p LEFT JOIN projects pr ON pr.id = p.project_id
		WHERE p.id = a.target_id AND (p.deleted_at <= ?1 OR pr.deleted_at <= ?1)))
)`;

const cutoff = (now: number) => now - PURGE_AFTER_MS;

/** How many files the next runs would purge (at most COUNT_CAP is counted). */
export async function countPurgeable(db: Db, now: number): Promise<number> {
	const row = await db.$client
		.prepare(
			`SELECT count(*) AS n FROM (SELECT 1 FROM attachments a WHERE ${PURGEABLE} LIMIT ${COUNT_CAP})`
		)
		.bind(cutoff(now))
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export interface PurgeResult {
	purged: number;
	/** More rows are left for another run. */
	more: boolean;
	/** R2 deletes that failed (the rows are tombstoned; the RUNBOOK orphan sweep removes the objects). */
	failedDeletes: number;
}

/** One batch: tombstone (guarded, at write time), then delete the R2 objects. */
export async function purgeDeletedParents(
	db: Db,
	files: R2Bucket,
	now: number
): Promise<PurgeResult> {
	const { results } = await db.$client
		.prepare(
			`UPDATE attachments SET deleted_at = ?2
			 WHERE id IN (SELECT a.id FROM attachments a WHERE ${PURGEABLE} ORDER BY a.id LIMIT ${PURGE_BATCH})
				AND deleted_at IS NULL
			 RETURNING r2_key AS r2Key`
		)
		.bind(cutoff(now), now)
		.all<{ r2Key: string }>();
	const keys = results.map((r) => r.r2Key);
	let failedDeletes = 0;
	if (keys.length) {
		try {
			await files.delete(keys);
		} catch (e) {
			failedDeletes = keys.length;
			console.error('attachment_purge_r2_delete_failed', {
				count: keys.length,
				error: errorLabel(e)
			});
		}
	}
	console.log('attachment_purge', { purged: keys.length });
	return {
		purged: keys.length,
		more: keys.length === PURGE_BATCH && (await countPurgeable(db, now)) > 0,
		failedDeletes
	};
}
