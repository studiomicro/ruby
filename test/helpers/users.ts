import type { UserRole } from '#lib/shared/enums';
import type { Db } from '#lib/server/db';
import { userPasswords, users } from '#lib/server/db/schema';
import { newCredential } from '#lib/server/auth/password';
import { newSession, type SessionUser } from '#lib/server/auth/session';
import { sessions } from '#lib/server/db/schema';

/** The password every test user gets unless a test names another. */
export const TEST_PASSWORD = 'quiet-harbour-41';

let counter = 0;

/**
 * Writes an active user with a password (TEST_PASSWORD unless given) straight into D1, for tests that need accounts
 * without going through setup or an invite. Returns the SessionUser shape `locals.user` holds.
 */
export async function insertUser(
	db: Db,
	options: {
		role?: UserRole;
		name?: string;
		email?: string;
		password?: string;
		status?: 'active' | 'disabled';
	} = {},
	now = Date.now()
): Promise<SessionUser> {
	counter += 1;
	const id = crypto.randomUUID();
	const user = {
		id,
		email: options.email ?? `user${counter}-${id.slice(0, 6)}@example.test`,
		name: options.name ?? `Test User ${counter}`,
		role: options.role ?? 'member'
	} satisfies SessionUser;
	const credential = await newCredential(options.password ?? TEST_PASSWORD);
	await db.batch([
		db.insert(users).values({ ...user, status: options.status ?? 'active', createdAt: now }),
		db.insert(userPasswords).values({ userId: id, ...credential, failedCount: 0, updatedAt: now })
	]);
	return user;
}

/** A live session for `userId` written straight into D1; returns the cookie token. */
export async function insertSession(db: Db, userId: string, now = Date.now()): Promise<string> {
	const { token, row } = await newSession(userId, now);
	await db.insert(sessions).values(row);
	return token;
}
