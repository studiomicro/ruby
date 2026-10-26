import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { hrAuditLog, users } from '../db/schema';
import { newId } from '../util';
import { auditStatement } from './audit';

/**
 * Grants or revokes the HR flag (`users.is_hr`). Admin only, checked inside the UPDATE (the actor must still be an
 * active admin), and only on an active account. An admin may grant themselves the flag: with the owner as the only
 * admin and the only HR user (owner answer 2026-10-26) there is nobody else to do it; the grant is audited and shown
 * in the HR audit log like any other. Repeating a grant or revoke is a no-op success.
 */
export async function setHrFlag(
	db: Db,
	actorId: string,
	targetId: string,
	isHr: boolean,
	now: number
): Promise<{ ok: true } | { ok: false; error: string }> {
	const v = isHr ? 1 : 0;
	const [written] = await db.$client.batch([
		db.$client
			.prepare(
				`UPDATE users SET is_hr = ?1 WHERE id = ?2 AND status = 'active' AND is_hr <> ?1
				 AND EXISTS (SELECT 1 FROM users a WHERE a.id = ?3 AND a.role = 'admin' AND a.status = 'active')`
			)
			.bind(v, targetId, actorId),
		auditStatement(db, {
			actorId,
			action: isHr ? 'hr_grant' : 'hr_revoke',
			userId: targetId,
			fields: ['is_hr'],
			at: now
		})
	]);
	if (written?.meta.changes === 1) return { ok: true };
	const row = await db.$client
		.prepare(
			`SELECT t.is_hr AS isHr, t.status AS status,
				EXISTS (SELECT 1 FROM users a WHERE a.id = ?2 AND a.role = 'admin' AND a.status = 'active') AS admin
			 FROM users t WHERE t.id = ?1`
		)
		.bind(targetId, actorId)
		.first<{ isHr: number; status: string; admin: number }>();
	if (row?.admin && row.status === 'active' && row.isHr === v) return { ok: true };
	return {
		ok: false,
		error: 'That user could not be changed. Only active accounts can hold HR access.'
	};
}

/**
 * Batch items for `setUserStatus` (auth/users.ts): when the account is now disabled, clear its HR flag and write an
 * `hr_revoke` row ("account disabled") in the same batch. Re-enabling the account does not restore the flag; an admin
 * grants it again (red team RB-05, account disable). Drizzle builders, because that batch is a Drizzle `db.batch`.
 */
export function clearHrOnDisable(db: Db, actorId: string, targetId: string, now: number) {
	return [
		db
			.update(users)
			.set({ isHr: false })
			.where(and(eq(users.id, targetId), eq(users.status, 'disabled'), eq(users.isHr, true))),
		db.insert(hrAuditLog).select((qb) =>
			qb
				.select({
					id: sql`${newId()}`.as('id'),
					at: sql`${now}`.as('at'),
					actorId: sql`${actorId}`.as('actor_id'),
					action: sql`'hr_revoke'`.as('action'),
					employeeId: sql`null`.as('employee_id'),
					userId: sql`${targetId}`.as('user_id'),
					fields: sql`'["is_hr"]'`.as('fields'),
					detail: sql`'account disabled'`.as('detail')
				})
				.from(sql`(select 1)`)
				.where(sql`changes() = 1`)
		)
	] as const;
}
