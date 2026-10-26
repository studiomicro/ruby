import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptInvite, createInvite, findLiveInvite } from '#lib/server/auth/invites';
import { PASSWORD_MAX_FAILURES, signInWithPassword } from '#lib/server/auth/password';
import { CLIENT_MAX_ATTEMPTS, overAttemptLimit } from '#lib/server/auth/throttle';
import {
	listUsers,
	mentionNames,
	NOT_LOCKED,
	setUserRole,
	setUserStatus,
	unlockUser
} from '#lib/server/auth/users';
import { getDb, type Db } from '#lib/server/db';
import { authAttempts, invites, users } from '#lib/server/db/schema';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { insertSession, insertUser, TEST_PASSWORD } from '../helpers/users';

/**
 * Red-team probes for RB-00 against a fresh local D1 (docs/features/rb-00-foundation/SECURITY_REPORT.md). The
 * report's PROOF tests now assert the fixed behaviour (M1, L2, L3, L5, L8 of fix cycle 1).
 */

const binding: { DB?: D1Database; ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string } = {
	ACCESS_TEAM_DOMAIN: '',
	ACCESS_AUD: ''
};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
const { handle } = await import('../../src/hooks.server');
const setupRoute = await import('../../src/routes/(auth)/setup/+page.server');
const adminUsers = await import('../../src/routes/(app)/admin/users/+page.server');

let db: Db;
let dispose: () => Promise<void>;
const NOW = 1_800_000_000_000;

beforeAll(async () => {
	const opened = await openLocalD1();
	binding.DB = opened.db;
	db = getDb(opened.db);
	dispose = opened.dispose;
});
afterAll(() => dispose());
beforeEach(async () => {
	for (const table of ['sessions', 'invites', 'user_passwords', 'auth_attempts', 'users'])
		await db.run(sql.raw(`delete from ${table}`));
});

const PW = 'long-enough-pw-1';

describe('invites end with their creator (M1)', () => {
	it('disabling an admin revokes their pending invites in the same batch; the link admits nobody', async () => {
		const ada = await insertUser(db, { role: 'admin' }, NOW);
		const bob = await insertUser(db, { role: 'admin' }, NOW);
		const invite = await createInvite(db, bob.id, 'friend-of-bob@example.test', 'admin', NOW);
		if (!invite.ok) throw new Error(invite.error);
		const adas = await createInvite(db, ada.id, 'ada-guest@example.test', 'member', NOW);
		if (!adas.ok) throw new Error(adas.error);
		expect((await setUserStatus(db, ada.id, bob.id, 'disabled', NOW)).ok).toBe(true);
		const rows = await db.select().from(invites).all();
		expect(rows.find((r) => r.id === invite.id)?.revokedAt).toBe(NOW);
		// Another admin's invites are untouched.
		expect(rows.find((r) => r.id === adas.id)?.revokedAt).toBeNull();
		expect(await findLiveInvite(db, invite.token, NOW + 1000)).toBeNull();
		const accepted = await acceptInvite(
			db,
			invite.token,
			{ name: 'Mallory', password: PW },
			NOW + 1000
		);
		expect(accepted.ok).toBe(false);
		expect(
			await db.select().from(users).where(eq(users.email, 'friend-of-bob@example.test')).get()
		).toBeUndefined();
		// Re-enabling Bob does not bring the link back.
		expect((await setUserStatus(db, ada.id, bob.id, 'active', NOW + 2000)).ok).toBe(true);
		expect((await acceptInvite(db, invite.token, { name: 'M', password: PW }, NOW + 3000)).ok).toBe(
			false
		);
	});

	it('demoting an admin revokes their pending invites; promoting revokes nothing', async () => {
		const ada = await insertUser(db, { role: 'admin' }, NOW);
		const bob = await insertUser(db, { role: 'admin' }, NOW);
		const invite = await createInvite(db, bob.id, 'x@example.test', 'admin', NOW);
		if (!invite.ok) throw new Error(invite.error);
		const adas = await createInvite(db, ada.id, 'y@example.test', 'member', NOW);
		if (!adas.ok) throw new Error(adas.error);
		const max = await insertUser(db, { role: 'member' }, NOW);
		expect((await setUserRole(db, ada.id, max.id, 'admin', NOW)).ok).toBe(true);
		expect((await setUserRole(db, ada.id, bob.id, 'member', NOW)).ok).toBe(true);
		const accepted = await acceptInvite(db, invite.token, { name: 'X', password: PW }, NOW + 1000);
		expect(accepted.ok).toBe(false);
		expect(
			(await db.select().from(invites).where(eq(invites.id, invite.id)).get())?.revokedAt
		).toBe(NOW);
		expect((await acceptInvite(db, adas.token, { name: 'Y', password: PW }, NOW + 1000)).ok).toBe(
			true
		);
	});

	it('a refused demotion (last admin) revokes nothing', async () => {
		const ada = await insertUser(db, { role: 'admin' }, NOW);
		const invite = await createInvite(db, ada.id, 'z@example.test', 'member', NOW);
		if (!invite.ok) throw new Error(invite.error);
		expect((await setUserRole(db, ada.id, ada.id, 'member', NOW)).ok).toBe(false);
		expect((await acceptInvite(db, invite.token, { name: 'Z', password: PW }, NOW + 1000)).ok).toBe(
			true
		);
	});

	it('accept refuses an unrevoked invite whose creator is no longer an active admin', async () => {
		const bob = await insertUser(db, { role: 'admin' }, NOW);
		const keep = await insertUser(db, { role: 'admin' }, NOW);
		const invite = await createInvite(db, bob.id, 'old-row@example.test', 'admin', NOW);
		if (!invite.ok) throw new Error(invite.error);
		// A row from before the fix: the creator changed without the revocation step.
		for (const change of [
			{ role: 'member' as const },
			{ role: 'admin' as const, status: 'disabled' as const }
		]) {
			await db.update(users).set(change).where(eq(users.id, bob.id));
			expect(await findLiveInvite(db, invite.token, NOW + 1)).toBeNull();
			expect((await acceptInvite(db, invite.token, { name: 'O', password: PW }, NOW + 1)).ok).toBe(
				false
			);
		}
		expect((await listUsers(db, NOW)).map((u) => u.id).sort()).toEqual([bob.id, keep.id].sort());
	});

	it('concurrent accepts racing a disable: every invite ends accepted xor revoked, and nothing in between', async () => {
		const ada = await insertUser(db, { role: 'admin' }, NOW);
		const bob = await insertUser(db, { role: 'admin' }, NOW);
		const made = [];
		for (let i = 0; i < 20; i++) {
			const invite = await createInvite(db, bob.id, `race-${i}@example.test`, 'admin', NOW);
			if (!invite.ok) throw new Error(invite.error);
			made.push(invite);
		}
		// Half the links are accepted while Ada disables Bob; the other half are never used during the race.
		const [disabled, ...accepts] = await Promise.all([
			setUserStatus(db, ada.id, bob.id, 'disabled', NOW + 1),
			...made
				.slice(0, 10)
				.map((m, i) => acceptInvite(db, m.token, { name: `R${i}`, password: PW }, NOW + 1))
		]);
		expect(disabled.ok).toBe(true);
		const rows = await db.select().from(invites).where(eq(invites.createdBy, bob.id)).all();
		const accepted = rows.filter((r) => r.acceptedAt !== null);
		expect(rows.every((r) => (r.acceptedAt === null) !== (r.revokedAt === null))).toBe(true);
		expect(accepted).toHaveLength(accepts.filter((a) => a.ok).length);
		// Every account an invite created came from an accept that ran while Bob was still an active admin.
		const created = (await listUsers(db, NOW)).filter((u) => u.email.startsWith('race-'));
		expect(created).toHaveLength(accepted.length);
		expect(rows.filter((r) => r.revokedAt !== null).length).toBeGreaterThanOrEqual(10);
		// After the race, no link of Bob's admits anyone.
		for (const m of made)
			expect((await acceptInvite(db, m.token, { name: 'L', password: PW }, NOW + 2)).ok).toBe(
				false
			);
	});
});

describe('lockout and throttle availability', () => {
	it('an admin unlocks a locked account at once; the lock still holds 15 minutes otherwise (L2)', async () => {
		const boss = await insertUser(db, { role: 'admin', email: 'boss@example.test' }, NOW);
		const other = await insertUser(db, { role: 'admin', email: 'other@example.test' }, NOW);
		const member = await insertUser(db, { role: 'member' }, NOW);
		for (let i = 0; i < PASSWORD_MAX_FAILURES; i++)
			await signInWithPassword(db, 'boss@example.test', `wrong-${i}-password`, NOW + i);
		expect(await signInWithPassword(db, 'boss@example.test', TEST_PASSWORD, NOW + 10)).toEqual({
			ok: false,
			error: 'locked'
		});
		const locked = (await listUsers(db, NOW + 10)).find((u) => u.id === boss.id);
		expect(locked?.lockedUntil).toBe(NOW + PASSWORD_MAX_FAILURES - 1 + 15 * 60 * 1000);
		// A member cannot unlock (SQL guard), and the route answers 403.
		expect((await unlockUser(db, member.id, boss.id, NOW + 20)).ok).toBe(false);
		const { event } = fakeEvent({
			url: 'http://localhost/admin/users?/unlock',
			db,
			user: member,
			form: { userId: boss.id }
		});
		const refused = await (async () => {
			try {
				await (adminUsers.actions.unlock as (e: never) => unknown)(event as never);
			} catch (e) {
				return e as { status?: number };
			}
			return null;
		})();
		expect(refused?.status).toBe(403);
		// Another admin unlocks through the action; the account signs in right away.
		const ok = fakeEvent({
			url: 'http://localhost/admin/users?/unlock',
			db,
			user: other,
			form: { userId: boss.id }
		});
		expect(await (adminUsers.actions.unlock as (e: never) => unknown)(ok.event as never)).toEqual({
			rowNotice: 'Account unlocked.'
		});
		expect((await listUsers(db, NOW + 30)).find((u) => u.id === boss.id)?.lockedUntil).toBeNull();
		expect((await signInWithPassword(db, 'boss@example.test', TEST_PASSWORD, NOW + 30)).ok).toBe(
			true
		);
		// Nothing left to unlock.
		expect(await unlockUser(db, other.id, boss.id, NOW + 40)).toEqual({
			ok: false,
			error: NOT_LOCKED
		});
	});

	it('an expired lock is not shown and not "unlocked"', async () => {
		const admin = await insertUser(db, { role: 'admin' }, NOW);
		const max = await insertUser(db, { email: 'max@example.test' }, NOW);
		for (let i = 0; i < PASSWORD_MAX_FAILURES; i++)
			await signInWithPassword(db, 'max@example.test', `wrong-${i}-password`, NOW);
		const later = NOW + 15 * 60 * 1000 + 1;
		expect((await listUsers(db, later)).find((u) => u.id === max.id)?.lockedUntil).toBeNull();
		expect(await unlockUser(db, admin.id, max.id, later)).toEqual({ ok: false, error: NOT_LOCKED });
	});

	it('one IPv4 address (an office NAT) has a budget of CLIENT_MAX_ATTEMPTS sign-ins (L3)', async () => {
		const req = () =>
			new Request('https://ruby.example.com/login', {
				headers: { 'cf-connecting-ip': '203.0.113.7' }
			});
		expect(CLIENT_MAX_ATTEMPTS).toBe(100);
		for (let i = 0; i < CLIENT_MAX_ATTEMPTS; i++)
			expect(await overAttemptLimit(db, req(), NOW, 'sign-in')).toBe(false);
		expect(await overAttemptLimit(db, req(), NOW, 'sign-in')).toBe(true);
	});

	it('client key: CF-Connecting-IP wins over spoofable X-Forwarded-For', async () => {
		const req = (xff: string) =>
			new Request('https://ruby.example.com/login', {
				headers: { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': xff }
			});
		for (let i = 0; i < CLIENT_MAX_ATTEMPTS; i++)
			await overAttemptLimit(db, req(`10.0.0.${i}`), NOW, 'sign-in');
		expect(await overAttemptLimit(db, req('10.9.9.9'), NOW, 'sign-in')).toBe(true);
	});
});

describe('mention names (L6)', () => {
	it('maps ids to current names, active and disabled, in any case; unknown ids are absent', async () => {
		const ada = await insertUser(db, { name: 'Ada Admin' }, NOW);
		const gone = await insertUser(db, { name: 'Gone User', status: 'disabled' }, NOW);
		const names = await mentionNames(db, [
			ada.id.toUpperCase(),
			gone.id,
			'00000000-0000-4000-8000-000000000009'
		]);
		expect(names).toEqual(
			new Map([
				[ada.id, 'Ada Admin'],
				[gone.id, 'Gone User']
			])
		);
		expect(await mentionNames(db, [])).toEqual(new Map());
	});

	it('binds the id list once (more than 100 ids)', async () => {
		const ada = await insertUser(db, { name: 'Ada' }, NOW);
		const ids = [...Array.from({ length: 150 }, () => crypto.randomUUID()), ada.id];
		expect((await mentionNames(db, ids)).get(ada.id)).toBe('Ada');
	});
});

describe('sign-in timing (informational)', () => {
	it('unknown e-mail vs wrong password: median cost', async () => {
		await insertUser(db, { email: 'known@example.test' }, NOW);
		const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
		const time = async (email: string, i: number) => {
			const t = performance.now();
			// Spread over time so the account never locks (each run starts after the previous lock window).
			await signInWithPassword(db, email, 'wrong-password-x', NOW + i * 16 * 60 * 1000);
			return performance.now() - t;
		};
		const unknown: number[] = [];
		const known: number[] = [];
		for (let i = 0; i < 15; i++) {
			unknown.push(await time('nobody@example.test', i));
			known.push(await time('known@example.test', i));
		}
		console.info('sign-in median ms', { unknown: median(unknown), known: median(known) });
	});
});

describe('setup after users exist', () => {
	it('answers 404 to the action before the throttle or any key derivation (L8)', async () => {
		await insertUser(db, { role: 'admin' }, NOW);
		const derive = vi.spyOn(crypto.subtle, 'deriveBits');
		const { event } = fakeEvent({
			url: 'http://localhost/setup',
			db,
			form: { name: 'Eve', email: 'eve@example.test', password: 'long-enough-pw-1' }
		});
		const err = await (async () => {
			try {
				await (setupRoute.actions.default as (e: never) => unknown)(event as never);
			} catch (e) {
				return e as { status?: number };
			}
			return null;
		})();
		expect(err?.status).toBe(404);
		expect(derive).not.toHaveBeenCalled();
		derive.mockRestore();
		expect(await db.select().from(authAttempts).all()).toHaveLength(0);
	});
});

describe('cache headers', () => {
	const resolve = vi.fn(
		async () => new Response('<p>page</p>', { headers: { 'content-type': 'text/html' } })
	);
	const run = async (init: Parameters<typeof fakeEvent>[0]) => {
		const { event } = fakeEvent(init);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		return handle({ event, resolve } as never);
	};

	it('a signed-in page is private, no-store', async () => {
		const user = await insertUser(db, {}, Date.now());
		const token = await insertSession(db, user.id, Date.now());
		const res = await run({
			url: 'http://localhost/',
			routeId: '/(app)',
			db,
			cookies: { ruby_session: token }
		});
		expect(res.headers.get('cache-control')).toBe('private, no-store');
	});

	it.each([
		[
			'/(auth)/invite/[token]',
			'http://localhost/invite/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
		],
		['/(auth)/login', 'http://localhost/login'],
		['/(auth)/setup', 'http://localhost/setup']
	])('the signed-out page %s is private, no-store (L5)', async (routeId, url) => {
		const res = await run({ url, routeId, db });
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('private, no-store');
	});

	it('an error response and every early answer are no-store; a route-set value is kept (L5)', async () => {
		resolve.mockImplementationOnce(async () => new Response('gone', { status: 404 }));
		expect((await run({ url: 'http://localhost/nope', db })).headers.get('cache-control')).toBe(
			'private, no-store'
		);
		resolve.mockImplementationOnce(
			async () => new Response('x', { headers: { 'cache-control': 'public, max-age=60' } })
		);
		const own = await run({ url: 'http://localhost/login', routeId: '/(auth)/login', db });
		expect(own.headers.get('cache-control')).toBe('public, max-age=60');
		// Signed-out request to an (app) route: the gate's redirect.
		const gate = await run({ url: 'http://localhost/projects', routeId: '/(app)/projects', db });
		expect(gate.status).toBe(303);
		expect(gate.headers.get('cache-control')).toBe('no-store');
		// Cross-site form POST.
		const csrf = await run({
			url: 'http://localhost/login',
			routeId: '/(auth)/login',
			db,
			form: { a: 'b' },
			headers: { origin: 'https://evil.example' }
		});
		expect(csrf.status).toBe(403);
		expect(csrf.headers.get('cache-control')).toBe('no-store');
		// Deployed host over plain http: the https redirect.
		const http = await run({ url: 'http://ruby.example.com/login', routeId: '/(auth)/login', db });
		expect(http.status).toBe(308);
		expect(http.headers.get('cache-control')).toBe('no-store');
		// Deployed host without Access configured: 503.
		const access = await run({
			url: 'https://ruby.example.com/login',
			routeId: '/(auth)/login',
			db
		});
		expect(access.status).toBe(503);
		expect(access.headers.get('cache-control')).toBe('no-store');
	});
});
