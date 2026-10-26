import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { sessions, userPasswords } from '../db/schema';
import { sha256Hex } from '../util';
import { newCredential } from './password';

/**
 * Replaces the password of `userId`, guarded on `provenHash` (the stored hash the current password was just proven
 * against), in one `db.batch` (one D1 transaction):
 *
 * 1. the credential UPDATE, only while the hash is still `provenHash`;
 * 2. every other session of the user is revoked (a password change is how people answer a suspected compromise),
 *    only while the hash is now the new one, so only when step 1 wrote. The session of `currentToken` stays.
 *
 * Of N concurrent changes exactly one commits; the rest find another hash and write nothing.
 */
export async function changePassword(
	db: Db,
	userId: string,
	provenHash: string,
	currentToken: string,
	newPassword: string,
	now: number
): Promise<boolean> {
	const credential = await newCredential(newPassword);
	const keepTokenHash = await sha256Hex(currentToken);
	const committed = sql`exists (select 1 from ${userPasswords} where ${userPasswords.userId} = ${userId}
		and ${userPasswords.hash} = ${credential.hash})`;
	const [changed] = await db.batch([
		db
			.update(userPasswords)
			.set({ ...credential, failedCount: 0, lockedUntil: null, updatedAt: now })
			.where(and(eq(userPasswords.userId, userId), eq(userPasswords.hash, provenHash)))
			.returning({ userId: userPasswords.userId }),
		db
			.update(sessions)
			.set({ revokedAt: now })
			.where(
				and(
					eq(sessions.userId, userId),
					ne(sessions.tokenHash, keepTokenHash),
					isNull(sessions.revokedAt),
					committed
				)
			)
	]);
	return changed.length === 1;
}
