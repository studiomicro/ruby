import { eq, sql } from 'drizzle-orm';
import { cleanText } from '#lib/shared/text';
import type { Db } from '../db';
import { userPasswords, users } from '../db/schema';
import { isUniqueViolation, newId } from '../util';
import { NAME_MAX_LENGTH } from './invites';
import { EMAIL_INVALID, NAME_REQUIRED } from './messages';
import {
	checkPasswordStrength,
	isPlausibleEmail,
	newCredential,
	normalizeEmail,
	PASSWORD_ERRORS
} from './password';
import { guardedSessionInsert, newSession } from './session';

/**
 * First-user setup (CLAUDE.md › Product boundaries): `/setup` creates the first account, as admin, only while the
 * `users` table is empty, and is a 404 from then on. The guard is the INSERT itself (`… WHERE NOT EXISTS (select 1
 * from users)`), so of two concurrent setups exactly one creates an account; the page check is only for display.
 */

/** True while no account exists (one indexed read). */
export async function setupOpen(db: Db): Promise<boolean> {
	const row = await db.select({ id: users.id }).from(users).limit(1).get();
	return row === undefined;
}

export type SetupErrors = Partial<Record<'form' | 'name' | 'email' | 'password', string>>;
export type SetupResult =
	| { ok: true; userId: string; token: string; expiresAt: number }
	| { ok: false; closed: boolean; errors: SetupErrors };

/** The answer when another setup won: the page is gone (the action turns it into a 404). */
const CLOSED: SetupResult = { ok: false, closed: true, errors: {} };

/**
 * Creates the first admin, their password and their first session in one `db.batch` (one D1 transaction): the user
 * row only while `users` is empty, the password and the session only while that row exists. A refused or failed
 * batch writes nothing.
 */
export async function createFirstAdmin(
	db: Db,
	input: { name: string; email: string; password: string },
	now: number
): Promise<SetupResult> {
	const name = cleanText(input.name, NAME_MAX_LENGTH);
	const email = normalizeEmail(input.email);
	const errors: SetupErrors = {};
	if (!name) errors.name = NAME_REQUIRED;
	if (!isPlausibleEmail(email)) errors.email = EMAIL_INVALID;
	const problem = checkPasswordStrength(input.password, email);
	if (problem) errors.password = PASSWORD_ERRORS[problem];
	if (Object.keys(errors).length) return { ok: false, closed: false, errors };

	const userId = newId();
	const credential = await newCredential(input.password);
	const { token, row: session } = await newSession(userId, now);
	const mine = sql`exists (select 1 from ${users} where ${users.id} = ${userId})`;
	let created: { id: string }[];
	try {
		[created] = await db.batch([
			db
				.insert(users)
				.select((qb) =>
					qb
						.select({
							id: sql`${userId}`.as('id'),
							email: sql`${email}`.as('email'),
							name: sql`${name}`.as('name'),
							role: sql`'admin'`.as('role'),
							status: sql`'active'`.as('status'),
							createdAt: sql`${now}`.as('created_at'),
							lastLoginAt: sql`${now}`.as('last_login_at'),
							// RB-05: nobody is HR by default (an admin grants it at /admin/users).
							isHr: sql`0`.as('is_hr')
						})
						.from(sql`(select 1)`)
						.where(sql`not exists (select 1 from ${users})`)
				)
				.returning({ id: users.id }),
			db.insert(userPasswords).select((qb) =>
				qb
					.select({
						userId: users.id,
						algo: sql`${credential.algo}`.as('algo'),
						hash: sql`${credential.hash}`.as('hash'),
						salt: sql`${credential.salt}`.as('salt'),
						iterations: sql`${credential.iterations}`.as('iterations'),
						failedCount: sql`0`.as('failed_count'),
						lockedUntil: sql`null`.as('locked_until'),
						updatedAt: sql`${now}`.as('updated_at')
					})
					.from(users)
					.where(eq(users.id, userId))
			),
			guardedSessionInsert(db, session, mine)
		]);
	} catch (e) {
		if (isUniqueViolation(e)) return CLOSED;
		throw e;
	}
	if (created.length !== 1) return CLOSED;
	return { ok: true, userId, token, expiresAt: session.expiresAt };
}
