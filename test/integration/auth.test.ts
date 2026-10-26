import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { changePassword } from '#lib/server/auth/change-password';
import {
	acceptInvite,
	createInvite,
	findLiveInvite,
	INVITE_TTL_MS,
	revokeInvite
} from '#lib/server/auth/invites';
import { INVITE_INVALID } from '#lib/server/auth/messages';
import { LOCKOUT_MS, PASSWORD_MAX_FAILURES, signInWithPassword } from '#lib/server/auth/password';
import {
	createPasswordSession,
	resolveSession,
	revokeSession,
	SESSION_TOUCH_MS,
	SESSION_TTL_MS
} from '#lib/server/auth/session';
import { createFirstAdmin, setupOpen } from '#lib/server/auth/setup';
import {
	LAST_ADMIN,
	listUsers,
	NOT_SELF,
	setUserRole,
	setUserStatus,
	updateOwnName
} from '#lib/server/auth/users';
import { getDb, type Db } from '#lib/server/db';
import { invites, sessions, userPasswords, users } from '#lib/server/db/schema';
import { sha256Hex } from '#lib/server/util';
import { openLocalD1 } from '../helpers/d1';
import { insertSession, insertUser, TEST_PASSWORD } from '../helpers/users';

/** Accounts, sessions, setup, invites and user administration against a fresh local D1 (workerd). */

let db: Db;
let dispose: () => Promise<void>;
const NOW = 1_800_000_000_000;

beforeAll(async () => {
	const opened = await openLocalD1();
	db = getDb(opened.db);
	dispose = opened.dispose;
});
afterAll(() => dispose());

/** Empties every account table so each block starts from a fresh install. */
async function wipe() {
	for (const table of ['sessions', 'invites', 'user_passwords', 'auth_attempts', 'users'])
		await db.run(sql.raw(`delete from ${table}`));
}

describe('first-user setup', () => {
	beforeEach(wipe);

	it('creates the admin with a session while users is empty, then closes', async () => {
		expect(await setupOpen(db)).toBe(true);
		const result = await createFirstAdmin(
			db,
			{ name: 'Ada Admin', email: ' Ada@Example.TEST ', password: 'first-light-2026' },
			NOW
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const user = await resolveSession(db, result.token, NOW);
		expect(user).toEqual({
			id: result.userId,
			email: 'ada@example.test',
			name: 'Ada Admin',
			role: 'admin'
		});
		expect(await setupOpen(db)).toBe(false);
		const again = await createFirstAdmin(
			db,
			{ name: 'Eve', email: 'eve@example.test', password: 'second-light-2026' },
			NOW
		);
		expect(again).toEqual({ ok: false, closed: true, errors: {} });
	});

	it('validates before writing anything', async () => {
		const result = await createFirstAdmin(
			db,
			{ name: '  ', email: 'nope', password: 'short' },
			NOW
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(Object.keys(result.errors).sort()).toEqual(['email', 'name', 'password']);
		expect(await setupOpen(db)).toBe(true);
	});

	it('two concurrent setups give exactly one admin, one password and one session', async () => {
		const attempts = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				createFirstAdmin(
					db,
					{ name: `Admin ${i}`, email: `admin${i}@example.test`, password: `race-password-${i}x` },
					NOW
				)
			)
		);
		expect(attempts.filter((a) => a.ok)).toHaveLength(1);
		expect(attempts.filter((a) => !a.ok && a.closed)).toHaveLength(4);
		const all = await listUsers(db, NOW);
		expect(all).toHaveLength(1);
		expect(all[0]?.role).toBe('admin');
		expect(await db.select().from(userPasswords).all()).toHaveLength(1);
		expect(await db.select().from(sessions).all()).toHaveLength(1);
	});
});

describe('password sign-in and sessions', () => {
	let user: Awaited<ReturnType<typeof insertUser>>;
	beforeEach(async () => {
		await wipe();
		user = await insertUser(db, { email: 'dewi@example.test', name: 'Dewi' }, NOW);
	});

	it('signs in, resolves the session with the role, and revokes only that session', async () => {
		const result = await signInWithPassword(db, 'DEWI@example.test', TEST_PASSWORD, NOW);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const one = await createPasswordSession(db, user.id, result.hash, NOW);
		const two = await createPasswordSession(db, user.id, result.hash, NOW);
		expect(one && two).toBeTruthy();
		expect(await resolveSession(db, one!.token, NOW)).toEqual(user);
		// The cookie token is never stored, only its hash.
		const stored = await db.select({ h: sessions.tokenHash }).from(sessions).all();
		expect(stored.map((s) => s.h)).not.toContain(one!.token);
		expect(stored.map((s) => s.h)).toContain(await sha256Hex(one!.token));
		expect(await revokeSession(db, one!.token, NOW)).toBe(1);
		expect(await resolveSession(db, one!.token, NOW)).toBeNull();
		expect(await resolveSession(db, two!.token, NOW)).toEqual(user);
	});

	it('answers an unknown e-mail exactly like a wrong password', async () => {
		expect(await signInWithPassword(db, 'nobody@example.test', TEST_PASSWORD, NOW)).toEqual({
			ok: false,
			error: 'invalid_credentials'
		});
		expect(await signInWithPassword(db, 'dewi@example.test', 'wrong-password-1', NOW)).toEqual({
			ok: false,
			error: 'invalid_credentials'
		});
	});

	it('locks after the failure limit, refuses the right password while locked, clears after', async () => {
		for (let i = 0; i < PASSWORD_MAX_FAILURES; i++)
			await signInWithPassword(db, 'dewi@example.test', `wrong-password-${i}`, NOW);
		expect(await signInWithPassword(db, 'dewi@example.test', TEST_PASSWORD, NOW + 1)).toEqual({
			ok: false,
			error: 'locked'
		});
		expect(
			(await signInWithPassword(db, 'dewi@example.test', TEST_PASSWORD, NOW + LOCKOUT_MS)).ok
		).toBe(true);
	});

	it('expires a session after 30 days and touches last_seen_at at most hourly', async () => {
		const token = await insertSession(db, user.id, NOW);
		expect(await resolveSession(db, token, NOW + SESSION_TTL_MS - 1)).not.toBeNull();
		expect(await resolveSession(db, token, NOW + SESSION_TTL_MS)).toBeNull();
		const fresh = await insertSession(db, user.id, NOW);
		await resolveSession(db, fresh, NOW + 1000);
		const seen = async () =>
			(
				await db
					.select({ seen: sessions.lastSeenAt })
					.from(sessions)
					.where(eq(sessions.tokenHash, await sha256Hex(fresh)))
					.get()
			)?.seen;
		expect(await seen()).toBe(NOW);
		await resolveSession(db, fresh, NOW + SESSION_TOUCH_MS);
		expect(await seen()).toBe(NOW + SESSION_TOUCH_MS);
	});

	it('writes no session when the password changed between check and write', async () => {
		const result = await signInWithPassword(db, 'dewi@example.test', TEST_PASSWORD, NOW);
		if (!result.ok) throw new Error('sign-in failed');
		await db
			.update(userPasswords)
			.set({ hash: 'changed' })
			.where(eq(userPasswords.userId, user.id));
		expect(await createPasswordSession(db, user.id, result.hash, NOW)).toBeNull();
	});

	it('writes no session for a user disabled between check and write', async () => {
		const result = await signInWithPassword(db, 'dewi@example.test', TEST_PASSWORD, NOW);
		if (!result.ok) throw new Error('sign-in failed');
		await db.update(users).set({ status: 'disabled' }).where(eq(users.id, user.id));
		expect(await createPasswordSession(db, user.id, result.hash, NOW)).toBeNull();
	});

	it('a password change revokes every other session and keeps this one', async () => {
		const current = await insertSession(db, user.id, NOW);
		const other = await insertSession(db, user.id, NOW);
		const proof = await signInWithPassword(db, user.email, TEST_PASSWORD, NOW);
		if (!proof.ok) throw new Error('sign-in failed');
		expect(await changePassword(db, user.id, proof.hash, current, 'brand-new-secret-9', NOW)).toBe(
			true
		);
		expect(await resolveSession(db, current, NOW)).not.toBeNull();
		expect(await resolveSession(db, other, NOW)).toBeNull();
		expect((await signInWithPassword(db, user.email, 'brand-new-secret-9', NOW)).ok).toBe(true);
		// A second change from the same (now stale) proof writes nothing.
		expect(await changePassword(db, user.id, proof.hash, current, 'another-secret-99', NOW)).toBe(
			false
		);
	});

	it('updates the own name, cleaned', async () => {
		expect(await updateOwnName(db, user.id, '  Dewi ​Lestari\n ')).toEqual({
			ok: true,
			name: 'Dewi Lestari'
		});
		expect((await updateOwnName(db, user.id, ' ​ ')).ok).toBe(false);
	});
});

describe('invites', () => {
	let admin: Awaited<ReturnType<typeof insertUser>>;
	beforeEach(async () => {
		await wipe();
		admin = await insertUser(db, { role: 'admin', email: 'ada@example.test', name: 'Ada' }, NOW);
	});

	it('stores only the token hash and admits the invited address with the invited role', async () => {
		const invite = await createInvite(db, admin.id, ' New.Person@Example.test ', 'admin', NOW);
		if (!invite.ok) throw new Error(invite.error);
		expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const row = await db.select().from(invites).where(eq(invites.id, invite.id)).get();
		expect(row?.tokenHash).toBe(await sha256Hex(invite.token));
		expect(JSON.stringify(row)).not.toContain(invite.token);
		expect(await findLiveInvite(db, invite.token, NOW)).toEqual({
			email: 'new.person@example.test',
			role: 'admin'
		});

		const accepted = await acceptInvite(
			db,
			invite.token,
			{ name: 'New Person', password: 'my-own-secret-1' },
			NOW
		);
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) return;
		expect(await resolveSession(db, accepted.token, NOW)).toEqual({
			id: accepted.userId,
			email: 'new.person@example.test',
			name: 'New Person',
			role: 'admin'
		});
		expect(
			(await signInWithPassword(db, 'new.person@example.test', 'my-own-secret-1', NOW)).ok
		).toBe(true);
		const used = await db.select().from(invites).where(eq(invites.id, invite.id)).get();
		expect(used?.acceptedBy).toBe(accepted.userId);
		expect(await findLiveInvite(db, invite.token, NOW)).toBeNull();
	});

	it('is one use under concurrency: exactly one of 10 accepts creates an account', async () => {
		const invite = await createInvite(db, admin.id, 'race@example.test', 'member', NOW);
		if (!invite.ok) throw new Error(invite.error);
		const results = await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				acceptInvite(db, invite.token, { name: `Racer ${i}`, password: `race-secret-${i}xx` }, NOW)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		for (const r of results.filter((r) => !r.ok))
			expect(r).toEqual({ ok: false, errors: { form: INVITE_INVALID } });
		const rows = await db.select().from(users).where(eq(users.email, 'race@example.test')).all();
		expect(rows).toHaveLength(1);
		const accepted = results.find((r) => r.ok);
		const sessionRows = await db
			.select()
			.from(sessions)
			.where(eq(sessions.userId, rows[0]!.id))
			.all();
		expect(sessionRows).toHaveLength(1);
		expect(accepted?.ok && accepted.userId).toBe(rows[0]?.id);
	});

	it('refuses an expired, a revoked and an unknown link with one answer', async () => {
		const expiring = await createInvite(db, admin.id, 'late@example.test', 'member', NOW);
		const revoked = await createInvite(db, admin.id, 'gone@example.test', 'member', NOW);
		if (!expiring.ok || !revoked.ok) throw new Error('invite failed');
		expect(await revokeInvite(db, admin.id, revoked.id, NOW)).toBe(true);
		expect(await revokeInvite(db, admin.id, revoked.id, NOW)).toBe(false);
		const input = { name: 'Someone', password: 'some-secret-123' };
		const late = await acceptInvite(db, expiring.token, input, NOW + INVITE_TTL_MS);
		const gone = await acceptInvite(db, revoked.token, input, NOW);
		const unknown = await acceptInvite(db, 'x'.repeat(43), input, NOW);
		const garbage = await acceptInvite(db, '../../etc', input, NOW);
		for (const r of [late, gone, unknown, garbage])
			expect(r).toEqual({ ok: false, errors: { form: INVITE_INVALID } });
		expect((await acceptInvite(db, expiring.token, input, NOW + INVITE_TTL_MS - 1)).ok).toBe(true);
		expect(
			await db.select().from(users).where(eq(users.email, 'gone@example.test')).all()
		).toHaveLength(0);
	});

	it('validates the name and password against the invited address', async () => {
		const invite = await createInvite(db, admin.id, 'sam@example.test', 'member', NOW);
		if (!invite.ok) throw new Error(invite.error);
		const result = await acceptInvite(
			db,
			invite.token,
			{ name: ' ', password: 'sam@example.test' },
			NOW
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(Object.keys(result.errors).sort()).toEqual(['name', 'password']);
		expect(await findLiveInvite(db, invite.token, NOW)).not.toBeNull();
	});

	it('refuses an address that already has an account, and a non-admin inviter', async () => {
		expect(await createInvite(db, admin.id, 'ada@example.test', 'member', NOW)).toEqual({
			ok: false,
			error: 'That e-mail address already has an account.'
		});
		const member = await insertUser(db, { role: 'member' }, NOW);
		expect((await createInvite(db, member.id, 'x@example.test', 'admin', NOW)).ok).toBe(false);
		expect((await createInvite(db, admin.id, 'not-an-email', 'member', NOW)).ok).toBe(false);
	});

	it('a new invite for the same address revokes the earlier one', async () => {
		const first = await createInvite(db, admin.id, 'twice@example.test', 'member', NOW);
		const second = await createInvite(db, admin.id, 'twice@example.test', 'member', NOW + 1);
		if (!first.ok || !second.ok) throw new Error('invite failed');
		expect(await findLiveInvite(db, first.token, NOW + 2)).toBeNull();
		expect(await findLiveInvite(db, second.token, NOW + 2)).not.toBeNull();
	});
});

describe('user administration', () => {
	let admin: Awaited<ReturnType<typeof insertUser>>;
	let member: Awaited<ReturnType<typeof insertUser>>;
	beforeEach(async () => {
		await wipe();
		admin = await insertUser(db, { role: 'admin', name: 'Ada' }, NOW);
		member = await insertUser(db, { role: 'member', name: 'Max' }, NOW);
	});

	it('disabling revokes every session of that user; enabling lets them sign in again', async () => {
		const a = await insertSession(db, member.id, NOW);
		const b = await insertSession(db, member.id, NOW);
		expect(await setUserStatus(db, admin.id, member.id, 'disabled', NOW)).toEqual({ ok: true });
		expect(await resolveSession(db, a, NOW)).toBeNull();
		const rows = await db.select().from(sessions).where(eq(sessions.userId, member.id)).all();
		expect(rows.every((r) => r.revokedAt === NOW)).toBe(true);
		expect((await signInWithPassword(db, member.email, TEST_PASSWORD, NOW)).ok).toBe(false);
		expect(await setUserStatus(db, admin.id, member.id, 'active', NOW)).toEqual({ ok: true });
		// Re-enabling does not bring the revoked sessions back.
		expect(await resolveSession(db, b, NOW)).toBeNull();
		expect((await signInWithPassword(db, member.email, TEST_PASSWORD, NOW)).ok).toBe(true);
	});

	it('a disabled user is signed out on the very next request even without revocation', async () => {
		const token = await insertSession(db, member.id, NOW);
		await db.update(users).set({ status: 'disabled' }).where(eq(users.id, member.id));
		expect(await resolveSession(db, token, NOW)).toBeNull();
	});

	it('a role change takes effect on the next request', async () => {
		const token = await insertSession(db, member.id, NOW);
		expect(await setUserRole(db, admin.id, member.id, 'admin', NOW)).toEqual({ ok: true });
		expect((await resolveSession(db, token, NOW))?.role).toBe('admin');
	});

	it('never leaves zero active admins: no self-demotion of the last admin, no disabling it', async () => {
		expect(await setUserRole(db, admin.id, admin.id, 'member', NOW)).toEqual({
			ok: false,
			error: LAST_ADMIN
		});
		expect(await setUserStatus(db, admin.id, admin.id, 'disabled', NOW)).toEqual({
			ok: false,
			error: NOT_SELF
		});
		const [row] = await listUsers(db, NOW).then((all) => all.filter((u) => u.id === admin.id));
		expect(row).toMatchObject({ role: 'admin', status: 'active' });
	});

	it('a member cannot change roles or statuses, the SQL refuses it', async () => {
		expect((await setUserRole(db, member.id, member.id, 'admin', NOW)).ok).toBe(false);
		expect((await setUserStatus(db, member.id, admin.id, 'disabled', NOW)).ok).toBe(false);
		expect((await listUsers(db, NOW)).find((u) => u.id === member.id)?.role).toBe('member');
	});

	it('two admins demoting each other at once: exactly one stays admin', async () => {
		const second = await insertUser(db, { role: 'admin', name: 'Bea' }, NOW);
		const [x, y] = await Promise.all([
			setUserRole(db, admin.id, second.id, 'member', NOW),
			setUserRole(db, second.id, admin.id, 'member', NOW)
		]);
		expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
		const admins = (await listUsers(db, NOW)).filter(
			(u) => u.role === 'admin' && u.status === 'active'
		);
		expect(admins).toHaveLength(1);
	});

	it('two admins disabling each other at once: exactly one stays active', async () => {
		const second = await insertUser(db, { role: 'admin', name: 'Bea' }, NOW);
		const results = await Promise.all([
			setUserStatus(db, admin.id, second.id, 'disabled', NOW),
			setUserStatus(db, second.id, admin.id, 'disabled', NOW)
		]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		const admins = (await listUsers(db, NOW)).filter(
			(u) => u.role === 'admin' && u.status === 'active'
		);
		expect(admins).toHaveLength(1);
	});

	it('the last admin is kept even when another admin is disabled meanwhile', async () => {
		const second = await insertUser(db, { role: 'admin', name: 'Bea' }, NOW);
		expect(await setUserStatus(db, admin.id, second.id, 'disabled', NOW)).toEqual({ ok: true });
		// A disabled admin is not an active one: demoting the only active admin is refused.
		expect(await setUserRole(db, admin.id, admin.id, 'member', NOW)).toEqual({
			ok: false,
			error: LAST_ADMIN
		});
		// A disabled admin's own requests can change nothing.
		expect((await setUserStatus(db, second.id, admin.id, 'disabled', NOW)).ok).toBe(false);
	});
});
