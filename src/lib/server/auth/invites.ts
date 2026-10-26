import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { UserRole } from '#lib/shared/enums';
import { cleanText } from '#lib/shared/text';
import type { Db } from '../db';
import { invites, userPasswords, users } from '../db/schema';
import { isUniqueViolation, newId, randomToken, sha256Hex } from '../util';
import { EMAIL_INVALID, INVITE_INVALID, NAME_REQUIRED } from './messages';
import {
	checkPasswordStrength,
	isPlausibleEmail,
	newCredential,
	normalizeEmail,
	PASSWORD_ERRORS
} from './password';
import { guardedSessionInsert, newSession } from './session';

/**
 * Invite-only accounts (CLAUDE.md › Product boundaries). An admin invites one e-mail address with a role; the link
 * `/invite/<token>` is shown to that admin once and never again: D1 keeps only the token's SHA-256. A link works for
 * INVITE_TTL_MS, once; an accepted, revoked or expired invite admits nobody. The new account's e-mail and role come
 * from the invite row, never from the accepting form.
 */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const NAME_MAX_LENGTH = 80;
/** `randomToken(32)`: 32 random bytes (256 bits) as 43 URL-safe base64 characters, like a session token. */
const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** Most pending invites the admin page lists (bounded read). */
const PENDING_LIST_MAX = 200;

const INVITE_PATH_PREFIX = '/invite/';
/** The path of an invite link; the raw token exists only in this link. */
export const invitePath = (token: string) => `${INVITE_PATH_PREFIX}${token}`;

/**
 * Whether a request URL carries an invite token: the invite page itself, or /login with the invite as `next`. Their
 * responses get `Referrer-Policy: strict-origin` so a Referer never carries the path.
 */
export function carriesInviteToken(url: URL): boolean {
	return (
		url.pathname.startsWith(INVITE_PATH_PREFIX) ||
		(url.searchParams.get('next') ?? '').startsWith(INVITE_PATH_PREFIX)
	);
}

/**
 * The path of a request for the app's own request log line (hooks.server.ts logs the route id instead when one
 * matched): an invite token in the path becomes `[token]`, also when the path was percent-encoded, and the query
 * string is left out, since `next=` can carry an invite link. Workers Logs' own invocation logs, which record the
 * full URL, are switched off in wrangler.jsonc.
 */
export function redactedPath(url: URL): string {
	let path = url.pathname;
	try {
		path = decodeURI(path);
	} catch {
		// Malformed escapes: redacted as given.
	}
	return path.replace(/^\/invite\/[^/]*/i, '/invite/[token]');
}

/** SQL: `actorId` is an active admin when the statement runs (a demoted or disabled admin's form does nothing). */
export const isActiveAdmin = (actorId: string) =>
	sql`exists (select 1 from ${users} where ${users.id} = ${actorId} and ${users.role} = 'admin' and ${users.status} = 'active')`;

export type CreateInviteResult =
	{ ok: true; id: string; token: string; expiresAt: number } | { ok: false; error: string };

/**
 * Creates an invite for `email` with `role`, in one `db.batch`: earlier pending invites for the same address are
 * revoked (one live link per address), then the new row is written only while the actor is an active admin and no
 * account has the address (INSERT … SELECT … WHERE NOT EXISTS). The token is returned to show once.
 */
export async function createInvite(
	db: Db,
	actorId: string,
	emailInput: string,
	role: UserRole,
	now: number
): Promise<CreateInviteResult> {
	const email = normalizeEmail(emailInput);
	if (!isPlausibleEmail(email)) return { ok: false, error: EMAIL_INVALID };
	const token = randomToken(32);
	const tokenHash = await sha256Hex(token);
	const id = newId();
	const expiresAt = now + INVITE_TTL_MS;
	const noAccount = sql`not exists (select 1 from ${users} where ${users.email} = ${email})`;
	const [, written] = await db.batch([
		db
			.update(invites)
			.set({ revokedAt: now })
			.where(
				and(
					eq(invites.email, email),
					isNull(invites.acceptedAt),
					isNull(invites.revokedAt),
					isActiveAdmin(actorId),
					noAccount
				)
			),
		db
			.insert(invites)
			.select((qb) =>
				qb
					.select({
						id: sql`${id}`.as('id'),
						tokenHash: sql`${tokenHash}`.as('token_hash'),
						email: sql`${email}`.as('email'),
						role: sql`${role}`.as('role'),
						createdBy: users.id,
						createdAt: sql`${now}`.as('created_at'),
						expiresAt: sql`${expiresAt}`.as('expires_at'),
						acceptedAt: sql`null`.as('accepted_at'),
						acceptedBy: sql`null`.as('accepted_by'),
						revokedAt: sql`null`.as('revoked_at')
					})
					.from(users)
					.where(and(eq(users.id, actorId), isActiveAdmin(actorId), noAccount))
			)
			.returning({ id: invites.id })
	]);
	if (written.length === 1) return { ok: true, id, token, expiresAt };
	const taken = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
	return {
		ok: false,
		error: taken
			? 'That e-mail address already has an account.'
			: 'Only an active admin can invite.'
	};
}

/** SQL: the invite row is still usable at `now`. */
const live = (now: number) =>
	and(isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now));

/**
 * SQL: the invite's creator is still an active admin, so could invite now. Disabling or demoting an admin revokes
 * their pending invites (users.ts); this keeps an invite that escaped that (an older row, a direct change) from
 * admitting anyone.
 */
const creatorMayInvite = sql`exists (select 1 from ${users} creator where creator.id = ${invites.createdBy}
	and creator.role = 'admin' and creator.status = 'active')`;

/** The live invite a link names, for the accept page (e-mail and role only), or null for any refused link. */
export async function findLiveInvite(
	db: Db,
	token: string,
	now: number
): Promise<{ email: string; role: UserRole } | null> {
	if (!INVITE_TOKEN.test(token)) return null;
	const row = await db
		.select({ email: invites.email, role: invites.role })
		.from(invites)
		.where(and(eq(invites.tokenHash, await sha256Hex(token)), live(now), creatorMayInvite))
		.get();
	return row ?? null;
}

export type AcceptInviteResult =
	| { ok: true; userId: string; token: string; expiresAt: number }
	| { ok: false; errors: { form?: string; name?: string; password?: string } };

/**
 * Accepts an invite: the account (e-mail and role from the invite), its password and its first session, in one
 * `db.batch` (one D1 transaction) of guarded statements:
 *
 * 1. the user row, INSERT … SELECT from the invite only while it is live, its creator is still an active admin
 *    and no account has its address;
 * 2. the invite is consumed (`accepted_at`, `accepted_by` = the new id) only while it is live and that user exists;
 * 3. the password and 4. the session, only while the invite names this new user as its acceptor.
 *
 * D1 runs batches one after another, so of N concurrent accepts of one link exactly one finds the invite live;
 * the others write nothing and get INVITE_INVALID. A failed batch leaves nothing behind.
 */
export async function acceptInvite(
	db: Db,
	token: string,
	input: { name: string; password: string },
	now: number
): Promise<AcceptInviteResult> {
	const invite = await findLiveInvite(db, token, now);
	if (!invite) return { ok: false, errors: { form: INVITE_INVALID } };
	const name = cleanText(input.name, NAME_MAX_LENGTH);
	const errors: { name?: string; password?: string } = {};
	if (!name) errors.name = NAME_REQUIRED;
	const problem = checkPasswordStrength(input.password, invite.email);
	if (problem) errors.password = PASSWORD_ERRORS[problem];
	if (Object.keys(errors).length) return { ok: false, errors };

	const tokenHash = await sha256Hex(token);
	const userId = newId();
	const credential = await newCredential(input.password);
	const { token: sessionToken, row: session } = await newSession(userId, now);
	const consumedByMe = sql`exists (select 1 from ${invites} where ${invites.tokenHash} = ${tokenHash}
		and ${invites.acceptedBy} = ${userId})`;
	let created: { id: string }[];
	try {
		[created] = await db.batch([
			db
				.insert(users)
				.select((qb) =>
					qb
						.select({
							id: sql`${userId}`.as('id'),
							email: invites.email,
							name: sql`${name}`.as('name'),
							role: invites.role,
							status: sql`'active'`.as('status'),
							createdAt: sql`${now}`.as('created_at'),
							lastLoginAt: sql`${now}`.as('last_login_at'),
							// RB-05: nobody is HR by default (an admin grants it at /admin/users).
							isHr: sql`0`.as('is_hr')
						})
						.from(invites)
						.where(
							and(
								eq(invites.tokenHash, tokenHash),
								live(now),
								creatorMayInvite,
								sql`not exists (select 1 from ${users} where ${users.email} = ${invites.email})`
							)
						)
				)
				.returning({ id: users.id }),
			db
				.update(invites)
				.set({ acceptedAt: now, acceptedBy: userId })
				.where(
					and(
						eq(invites.tokenHash, tokenHash),
						live(now),
						sql`exists (select 1 from ${users} where ${users.id} = ${userId})`
					)
				),
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
					.where(and(eq(users.id, userId), consumedByMe))
			),
			guardedSessionInsert(db, session, consumedByMe)
		]);
	} catch (e) {
		if (isUniqueViolation(e)) return { ok: false, errors: { form: INVITE_INVALID } };
		throw e;
	}
	if (created.length !== 1) return { ok: false, errors: { form: INVITE_INVALID } };
	return { ok: true, userId, token: sessionToken, expiresAt: session.expiresAt };
}

/** Revokes a pending invite, only while the actor is an active admin. True when this call revoked it. */
export async function revokeInvite(db: Db, actorId: string, inviteId: string, now: number) {
	const revoked = await db
		.update(invites)
		.set({ revokedAt: now })
		.where(
			and(
				eq(invites.id, inviteId),
				isNull(invites.acceptedAt),
				isNull(invites.revokedAt),
				isActiveAdmin(actorId)
			)
		)
		.returning({ id: invites.id });
	return revoked.length === 1;
}

/** The pending (live) invites, newest first, without token hashes. */
export async function listPendingInvites(db: Db, now: number) {
	return db
		.select({
			id: invites.id,
			email: invites.email,
			role: invites.role,
			createdAt: invites.createdAt,
			expiresAt: invites.expiresAt,
			createdByName: users.name
		})
		.from(invites)
		.innerJoin(users, eq(users.id, invites.createdBy))
		.where(live(now))
		.orderBy(desc(invites.createdAt))
		.limit(PENDING_LIST_MAX);
}
