import type { SessionUser } from '../auth/session';
import type { Db } from '../db';
import { auditStatement } from '../hr/audit';

/**
 * Admin purge of a DEACTIVATED user's calendar events (red team L1). Admins cannot see private events (owner answer
 * O2), so this works on counts only: no title, description or attendee ever leaves this module. Every live event the
 * user created is soft-deleted in one batch with an audit row (`calendar_events_purge`, the count as its detail).
 */

const prep = (db: Db, query: string, ...params: unknown[]) =>
	db.$client.prepare(query).bind(...params);

export interface PurgeCandidate {
	userId: string;
	name: string;
	events: number;
}

/** Deactivated users who still created live events, with the count (at most 200 users). */
export async function purgeCandidates(db: Db): Promise<PurgeCandidate[]> {
	const { results } = await prep(
		db,
		`SELECT u.id AS userId, u.name, count(e.id) AS events FROM users u
		 JOIN events e ON e.created_by = u.id AND e.deleted_at IS NULL
		 WHERE u.status = 'disabled' GROUP BY u.id ORDER BY u.name LIMIT 200`
	).all<PurgeCandidate>();
	return results;
}

/**
 * Soft-deletes every live event `userId` created, only while that user is deactivated. Returns how many were
 * removed (0 for an active, unknown or already purged user: nothing is written then, not even an audit row).
 */
export async function purgeDeactivatedUserEvents(
	db: Db,
	admin: Pick<SessionUser, 'id'>,
	userId: string,
	at: number
): Promise<number> {
	const row = await prep(
		db,
		`SELECT count(*) AS n FROM events e JOIN users u ON u.id = e.created_by
		 WHERE e.created_by = ?1 AND e.deleted_at IS NULL AND u.status = 'disabled'`,
		userId
	).first<{ n: number }>();
	const n = row?.n ?? 0;
	if (n === 0) return 0;
	const [updated] = await db.$client.batch([
		prep(
			db,
			`UPDATE events SET deleted_at = ?2, updated_at = max(?2, updated_at + 1)
			 WHERE created_by = ?1 AND deleted_at IS NULL
			   AND EXISTS (SELECT 1 FROM users u WHERE u.id = ?1 AND u.status = 'disabled')`,
			userId,
			at
		),
		auditStatement(
			db,
			{
				actorId: admin.id,
				action: 'calendar_events_purge',
				userId,
				fields: ['deleted_at'],
				detail: `${n} events`,
				at
			},
			false
		)
	]);
	return updated?.meta.changes ?? 0;
}
