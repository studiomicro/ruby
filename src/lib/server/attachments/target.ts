import type { Db } from '../db';
import { taskPath } from '../tasks/format';
import type { TargetKind } from '#lib/shared/enums';

/**
 * Whether an attachment's parent is live, as SQL: a task that is not deleted in a project that is not deleted (an
 * archived project still counts, owner decision 2026-10-26), or a page that is not deleted in the team space or a
 * live project. `?1` is the target kind, `?2` its id. Used by the guarded insert so a target that vanished between
 * the check and the write is caught in the same statement.
 */
export const TARGET_LIVE_SQL = `(
	(?1 = 'task' AND EXISTS (
		SELECT 1 FROM tasks t JOIN projects pr ON pr.id = t.project_id
		WHERE t.id = ?2 AND t.deleted_at IS NULL AND pr.deleted_at IS NULL))
	OR (?1 = 'page' AND EXISTS (
		SELECT 1 FROM pages p LEFT JOIN projects pr ON pr.id = p.project_id
		WHERE p.id = ?2 AND p.deleted_at IS NULL AND (p.project_id IS NULL OR pr.deleted_at IS NULL)))
)`;

/** The live target's canonical page, or null when the task or page (or its project) is gone. */
export async function liveTargetPath(db: Db, kind: TargetKind, id: string): Promise<string | null> {
	if (kind === 'task') {
		const row = await db.$client
			.prepare(
				`SELECT pr.key AS key, t.number AS number FROM tasks t JOIN projects pr ON pr.id = t.project_id
				 WHERE t.id = ?1 AND t.deleted_at IS NULL AND pr.deleted_at IS NULL LIMIT 1`
			)
			.bind(id)
			.first<{ key: string; number: number }>();
		return row ? taskPath(row.key, row.number) : null;
	}
	const row = await db.$client
		.prepare(
			`SELECT p.id AS id FROM pages p LEFT JOIN projects pr ON pr.id = p.project_id
			 WHERE p.id = ?1 AND p.deleted_at IS NULL AND (p.project_id IS NULL OR pr.deleted_at IS NULL) LIMIT 1`
		)
		.bind(id)
		.first<{ id: string }>();
	return row ? `/kb/${row.id}` : null;
}

/** Whether the task or page is live (`TARGET_LIVE_SQL`). */
export const targetIsLive = async (db: Db, kind: TargetKind, id: string): Promise<boolean> =>
	(await liveTargetPath(db, kind, id)) !== null;
