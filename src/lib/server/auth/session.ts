import type { Cookies } from '@sveltejs/kit';
import { and, eq, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db';
import { sessions, userPasswords, users } from '../db/schema';
import { newId, randomToken, sha256Hex } from '../util';

/**
 * Sessions. 30-day absolute
 * lifetime, no idle sign-out; `last_seen_at` is kept for the admin list only, never for revocation.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is written at most once per this interval (a guarded UPDATE), not on every request. */
export const SESSION_TOUCH_MS = 60 * 60 * 1000;

/**
 * The cookie's base name. A secure deployment uses `__Host-ruby_session`: the browser refuses it unless it is
 * Secure, Path=/ and has no Domain, so no subdomain of the app host or plain-http origin can plant one. Local dev over
 * `http://` cannot set a `__Host-` cookie, so there the name is plain.
 */
const SESSION_COOKIE = 'ruby_session';
export const sessionCookieName = (secure: boolean) =>
	secure ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1|.+\.localhost)$/i;

/**
 * Whether this host is a deployment served over HTTPS (and behind Cloudflare Access). Decided by the host name,
 * never the request's scheme: every Cloudflare-served host is HTTPS (a plain-http request is redirected by the hook
 * before any cookie is read); only loopback names (`localhost`, `*.localhost`, 127.0.0.1, ::1) are local dev.
 * Kit 3's adapter passes no `platform`, so an env flag is not used here.
 */
export function secureDeployment(hostname: string): boolean {
	return !LOCAL_HOST.test(hostname.replace(/\.$/, ''));
}

/** What `locals.user` holds: never a password, session or token hash. */
export type SessionUser = Pick<typeof users.$inferSelect, 'id' | 'email' | 'name' | 'role'>;

/** A new session's row and token: only the cookie carries the token, D1 its hash. */
export async function newSession(userId: string, now: number) {
	const token = randomToken(32);
	const row = {
		id: newId(),
		tokenHash: await sha256Hex(token),
		userId,
		createdAt: now,
		expiresAt: now + SESSION_TTL_MS,
		revokedAt: null,
		lastSeenAt: now
	};
	return { token, row };
}

/**
 * The session-row INSERT … SELECT for `row`: written only while its user exists, is active and `where` holds. Setup,
 * invite acceptance and password sign-in put it in the same `db.batch` as the write it depends on, so a session can
 * only follow a write that really happened.
 */
export function guardedSessionInsert(
	db: Db,
	row: Awaited<ReturnType<typeof newSession>>['row'],
	where: SQL
) {
	return db
		.insert(sessions)
		.select((qb) =>
			qb
				.select({
					id: sql`${row.id}`.as('id'),
					tokenHash: sql`${row.tokenHash}`.as('token_hash'),
					userId: users.id,
					createdAt: sql`${row.createdAt}`.as('created_at'),
					expiresAt: sql`${row.expiresAt}`.as('expires_at'),
					revokedAt: sql`null`.as('revoked_at'),
					lastSeenAt: sql`${row.lastSeenAt}`.as('last_seen_at')
				})
				.from(users)
				.where(and(eq(users.id, row.userId), eq(users.status, 'active'), where))
		)
		.returning({ id: sessions.id });
}

/**
 * The session of a password sign-in, written only while the account is active and its password is still the one
 * the sign-in checked (INSERT … SELECT … WHERE): an account disabled, or a password changed, between the check and
 * this write gets no session. `last_login_at` is updated in the same batch. Null when refused.
 */
export async function createPasswordSession(db: Db, userId: string, hash: string, now: number) {
	const { token, row } = await newSession(userId, now);
	const [written] = await db.batch([
		guardedSessionInsert(
			db,
			row,
			sql`exists (select 1 from ${userPasswords} where ${userPasswords.userId} = ${userId}
				and ${userPasswords.hash} = ${hash})`
		),
		db
			.update(users)
			.set({ lastLoginAt: now })
			.where(
				and(
					eq(users.id, userId),
					sql`exists (select 1 from ${sessions} where ${sessions.id} = ${row.id})`
				)
			)
	]);
	return written.length ? { token, expiresAt: row.expiresAt } : null;
}

/**
 * The signed-in user of `token`, or null when the session is unknown, revoked, expired or its user is not active.
 * One indexed lookup on the token hash, so a disabled user or a changed role takes effect on the very next request;
 * `last_seen_at` is touched at most once per SESSION_TOUCH_MS.
 */
export async function resolveSession(
	db: Db,
	token: string,
	now: number
): Promise<SessionUser | null> {
	const found = await db
		.select({
			sessionId: sessions.id,
			expiresAt: sessions.expiresAt,
			revokedAt: sessions.revokedAt,
			lastSeenAt: sessions.lastSeenAt,
			createdAt: sessions.createdAt,
			user: {
				id: users.id,
				email: users.email,
				name: users.name,
				role: users.role,
				status: users.status
			}
		})
		.from(sessions)
		.innerJoin(users, eq(users.id, sessions.userId))
		.where(eq(sessions.tokenHash, await sha256Hex(token)))
		.get();
	if (!found || found.revokedAt !== null || found.expiresAt <= now) return null;
	if (found.user.status !== 'active') return null;
	if (now - (found.lastSeenAt ?? found.createdAt) >= SESSION_TOUCH_MS)
		await db
			.update(sessions)
			.set({ lastSeenAt: now })
			.where(
				and(
					eq(sessions.id, found.sessionId),
					isNull(sessions.revokedAt),
					lte(sql`coalesce(${sessions.lastSeenAt}, ${sessions.createdAt})`, now - SESSION_TOUCH_MS)
				)
			);
	const { id, email, name, role } = found.user;
	return { id, email, name, role };
}

/** Revokes the one session `token` names (sign-out on this device); other devices stay signed in. */
export async function revokeSession(db: Db, token: string, now: number) {
	const revoked = await db
		.update(sessions)
		.set({ revokedAt: now })
		.where(and(eq(sessions.tokenHash, await sha256Hex(token)), isNull(sessions.revokedAt)))
		.returning({ id: sessions.id });
	return revoked.length;
}

const cookieOptions = (secure: boolean) => ({
	path: '/',
	httpOnly: true,
	sameSite: 'lax' as const,
	secure
});

export function setSessionCookie(
	cookies: Cookies,
	token: string,
	expiresAt: number,
	secure: boolean
) {
	cookies.set(sessionCookieName(secure), token, {
		...cookieOptions(secure),
		expires: new Date(expiresAt)
	});
}

/** Clears the cookie; returns the `Set-Cookie` value for responses built outside `resolve()`. */
export function clearSessionCookie(cookies: Cookies, secure: boolean): string {
	const options = { ...cookieOptions(secure), maxAge: 0 };
	const name = sessionCookieName(secure);
	cookies.delete(name, options);
	return cookies.serialize(name, '', options);
}
