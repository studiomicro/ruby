import { and, asc, eq, gt, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { UserRole } from '#lib/shared/enums';
import { cleanText } from '#lib/shared/text';
import type { Db } from '../db';
import { invites, sessions, userPasswords, users } from '../db/schema';
import { clearHrOnDisable } from '../hr/grant';
import { isActiveAdmin, NAME_MAX_LENGTH } from './invites';
import { NAME_REQUIRED } from './messages';

/**
 * User administration (admins only; the routes call requireAdmin first) and the profile name. Every rule that
 * protects the team lives in the guarded SQL, not only in JavaScript: the actor must still be an active admin when
 * the statement runs, and no statement ever leaves zero active admins. D1 runs batches one after another, so two
 * admins demoting or disabling each other at once end with exactly one of them still an active admin.
 */

/** Most users the admin list reads (one team; bounded anyway). */
const USER_LIST_MAX = 500;

/**
 * Every account for the admin page: no password, session or token data. `lockedUntil` is the end of a sign-in lock
 * still in force at `now` (password.ts › LOCKOUT_MS), else null.
 */
export async function listUsers(db: Db, now: number) {
	return db
		.select({
			id: users.id,
			email: users.email,
			name: users.name,
			role: users.role,
			status: users.status,
			isHr: users.isHr,
			createdAt: users.createdAt,
			lastLoginAt: users.lastLoginAt,
			lockedUntil: sql<
				number | null
			>`case when ${userPasswords.lockedUntil} > ${now} then ${userPasswords.lockedUntil} else null end`
		})
		.from(users)
		.leftJoin(userPasswords, eq(userPasswords.userId, users.id))
		.orderBy(asc(users.name), asc(users.email))
		.limit(USER_LIST_MAX);
}

/**
 * The current display names of the users `ids` names (active and disabled alike), for rendering mentions
 * (`renderMarkdown(source, names)`): a mention shows who it really notifies, never the label its author typed.
 * At most USER_LIST_MAX distinct ids are looked up, bound once as JSON (no per-id parameters). `markDeactivated`
 * (RB-03 comments and inbox excerpts) appends " (deactivated)" to a disabled user's name.
 */
export async function mentionNames(
	db: Db,
	ids: readonly string[],
	options: { markDeactivated?: boolean } = {}
): Promise<Map<string, string>> {
	const wanted = [...new Set(ids.map((id) => id.toLowerCase()))].slice(0, USER_LIST_MAX);
	if (wanted.length === 0) return new Map();
	const rows = await db
		.select({ id: users.id, name: users.name, status: users.status })
		.from(users)
		.where(
			and(
				sql`${users.id} in (select value from json_each(${JSON.stringify(wanted)}))`,
				sql`${users.status} in ('active', 'disabled')`
			)
		)
		.limit(USER_LIST_MAX);
	return new Map(
		rows.map((r) => [
			r.id.toLowerCase(),
			options.markDeactivated && r.status === 'disabled' ? `${r.name} (deactivated)` : r.name
		])
	);
}

/** Active users for pickers (assignee, mentions), by name. */
export async function listActiveUsers(db: Db) {
	return db
		.select({ id: users.id, name: users.name, email: users.email })
		.from(users)
		.where(eq(users.status, 'active'))
		.orderBy(asc(users.name))
		.limit(USER_LIST_MAX);
}

/**
 * SQL: after `target` stops being an active admin, at least one other active admin remains — or `target` is not an
 * active admin now, so the change cannot lower the count.
 */
const keepsAnAdmin = (targetId: string) =>
	sql`(not (${users.role} = 'admin' and ${users.status} = 'active')
		or (select count(*) from ${users} other where other.id <> ${targetId}
			and other.role = 'admin' and other.status = 'active') >= 1)`;

export const LAST_ADMIN = 'Ruby needs at least one active admin.';
export const NOT_SELF = 'You cannot disable your own account.';
const NO_CHANGE = 'That user could not be changed. Reload the page and try again.';
export const NOT_LOCKED = 'That account is not locked.';

export type AdminChange = { ok: true } | { ok: false; error: string };

/** Why a guarded change wrote nothing, for the admin's message (read after the refusal). */
async function refusalReason(db: Db, actorId: string, targetId: string): Promise<string> {
	const [actor, target] = await Promise.all([
		db
			.select({ role: users.role, status: users.status })
			.from(users)
			.where(eq(users.id, actorId))
			.get(),
		db
			.select({ role: users.role, status: users.status })
			.from(users)
			.where(eq(users.id, targetId))
			.get()
	]);
	if (!actor || actor.role !== 'admin' || actor.status !== 'active') return NO_CHANGE;
	if (target?.role === 'admin' && target.status === 'active') return LAST_ADMIN;
	return NO_CHANGE;
}

/**
 * Revokes every pending invite `targetId` created, guarded on `stillApplies` (the change that ends their power to
 * invite has been written). Runs in the same `db.batch` as that change, so a disabled or demoted admin's links stop
 * working at once. acceptInvite also refuses an invite whose creator is no longer an active admin.
 */
const revokeInvitesBy = (db: Db, targetId: string, now: number, stillApplies: SQL) =>
	db
		.update(invites)
		.set({ revokedAt: now })
		.where(
			and(
				eq(invites.createdBy, targetId),
				isNull(invites.acceptedAt),
				isNull(invites.revokedAt),
				stillApplies
			)
		);

/**
 * Disables or re-enables `targetId`. Disabling revokes every live session, every pending invite and the HR flag of
 * that user in the same batch (and resolveSession refuses a disabled user's session anyway, so the very next request
 * is signed out). Refused for oneself and when it would leave no active admin.
 */
export async function setUserStatus(
	db: Db,
	actorId: string,
	targetId: string,
	status: 'active' | 'disabled',
	now: number
): Promise<AdminChange> {
	if (status === 'disabled' && actorId === targetId) return { ok: false, error: NOT_SELF };
	const disabled = sql`exists (select 1 from ${users} where ${users.id} = ${targetId} and ${users.status} = 'disabled')`;
	const [changed] = await db.batch([
		db
			.update(users)
			.set({ status })
			.where(
				and(
					eq(users.id, targetId),
					ne(users.status, status),
					isActiveAdmin(actorId),
					...(status === 'disabled' ? [keepsAnAdmin(targetId), ne(users.id, actorId)] : [])
				)
			)
			.returning({ id: users.id }),
		db
			.update(sessions)
			.set({ revokedAt: now })
			.where(and(eq(sessions.userId, targetId), isNull(sessions.revokedAt), disabled)),
		revokeInvitesBy(db, targetId, now, disabled),
		// RB-05: a disabled account loses HR access (audited); re-enabling does not restore it.
		...(status === 'disabled' ? clearHrOnDisable(db, actorId, targetId, now) : [])
	]);
	if (changed.length === 1) return { ok: true };
	return { ok: false, error: await refusalReason(db, actorId, targetId) };
}

/**
 * Changes `targetId`'s role; a demotion is refused when it would leave no active admin (oneself included). A
 * demotion revokes the target's pending invites in the same batch (a member cannot invite).
 */
export async function setUserRole(
	db: Db,
	actorId: string,
	targetId: string,
	role: UserRole,
	now: number
): Promise<AdminChange> {
	const update = db
		.update(users)
		.set({ role })
		.where(
			and(
				eq(users.id, targetId),
				ne(users.role, role),
				isActiveAdmin(actorId),
				...(role === 'admin' ? [] : [keepsAnAdmin(targetId)])
			)
		)
		.returning({ id: users.id });
	const notAdmin = sql`exists (select 1 from ${users} where ${users.id} = ${targetId} and ${users.role} <> 'admin')`;
	const [changed] =
		role === 'admin'
			? [await update]
			: await db.batch([update, revokeInvitesBy(db, targetId, now, notAdmin)]);
	if (changed.length === 1) return { ok: true };
	return { ok: false, error: await refusalReason(db, actorId, targetId) };
}

/**
 * Ends a sign-in lock of `targetId` that is in force at `now` (password.ts locks an account for LOCKOUT_MS after
 * PASSWORD_MAX_FAILURES wrong passwords): the failure count goes back to 0. One guarded statement, written only
 * while the actor is an active admin.
 */
export async function unlockUser(
	db: Db,
	actorId: string,
	targetId: string,
	now: number
): Promise<AdminChange> {
	const changed = await db
		.update(userPasswords)
		.set({ failedCount: 0, lockedUntil: null })
		.where(
			and(
				eq(userPasswords.userId, targetId),
				gt(userPasswords.lockedUntil, now),
				isActiveAdmin(actorId)
			)
		)
		.returning({ userId: userPasswords.userId });
	if (changed.length === 1) return { ok: true };
	const actor = await db
		.select({ role: users.role, status: users.status })
		.from(users)
		.where(eq(users.id, actorId))
		.get();
	return {
		ok: false,
		error: actor?.role === 'admin' && actor.status === 'active' ? NOT_LOCKED : NO_CHANGE
	};
}

/** The signed-in user's own display name. */
export async function updateOwnName(
	db: Db,
	userId: string,
	input: string
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
	const name = cleanText(input, NAME_MAX_LENGTH);
	if (!name) return { ok: false, error: NAME_REQUIRED };
	const changed = await db
		.update(users)
		.set({ name })
		.where(and(eq(users.id, userId), eq(users.status, 'active')))
		.returning({ id: users.id });
	return changed.length === 1 ? { ok: true, name } : { ok: false, error: NO_CHANGE };
}
