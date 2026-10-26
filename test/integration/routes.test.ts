import { isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, type Db } from '#lib/server/db';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { insertUser } from '../helpers/users';

/** The foundation routes' loads and actions called directly: who may reach what, and what page data holds. */

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const setup = await import('../../src/routes/(auth)/setup/+page.server');
const login = await import('../../src/routes/(auth)/login/+page.server');
const invite = await import('../../src/routes/(auth)/invite/[token]/+page.server');
const adminUsers = await import('../../src/routes/(app)/admin/users/+page.server');

let db: Db;
let dispose: () => Promise<void>;
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

type Fn = (event: never) => unknown;
const call = (fn: unknown, event: unknown) => (fn as Fn)(event as never);
async function thrown(promise: unknown): Promise<unknown> {
	try {
		await promise;
	} catch (e) {
		return e;
	}
	return null;
}

describe('setup and login', () => {
	it('/login sends a fresh install to /setup; /setup is 404 once any user exists', async () => {
		const toSetup = await thrown(
			call(login.load, fakeEvent({ url: 'http://localhost/login', db }).event)
		);
		expect(isRedirect(toSetup) && toSetup.location).toBe('/setup');
		expect(await call(setup.load, fakeEvent({ url: 'http://localhost/setup', db }).event)).toEqual(
			{}
		);
		await insertUser(db);
		const gone = await thrown(
			call(setup.load, fakeEvent({ url: 'http://localhost/setup', db }).event)
		);
		expect(isHttpError(gone) && gone.status).toBe(404);
		const post = fakeEvent({
			url: 'http://localhost/setup',
			db,
			form: { name: 'Late', email: 'late@example.test', password: 'late-password-1' }
		});
		const refused = await thrown(call(setup.actions.default, post.event));
		expect(isHttpError(refused) && refused.status).toBe(404);
	});

	it('setup signs the first admin in with an httpOnly, SameSite=Lax cookie', async () => {
		const { event, written } = fakeEvent({
			url: 'http://localhost/setup',
			db,
			form: { name: 'Ada', email: 'ada@example.test', password: 'first-light-2026' }
		});
		const done = await thrown(call(setup.actions.default, event));
		expect(isRedirect(done) && done.location).toBe('/');
		const cookie = written.get('ruby_session');
		expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(cookie?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
	});
});

describe('admin users', () => {
	it('a member gets 403 on the page and on every action', async () => {
		const member = await insertUser(db, { role: 'member' });
		const page = await thrown(
			call(
				adminUsers.load,
				fakeEvent({ url: 'http://localhost/admin/users', db, user: member }).event
			)
		);
		expect(isHttpError(page) && page.status).toBe(403);
		for (const name of ['invite', 'revokeInvite', 'setStatus', 'setRole'] as const) {
			const { event } = fakeEvent({
				url: `http://localhost/admin/users?/${name}`,
				db,
				user: member,
				form: {
					email: 'x@example.test',
					role: 'admin',
					userId: member.id,
					status: 'disabled',
					inviteId: 'x'
				}
			});
			const refused = await thrown(call(adminUsers.actions[name], event));
			expect(isHttpError(refused) && refused.status, name).toBe(403);
		}
	});

	it('an invite link is returned by the action once; no page data ever holds a token', async () => {
		const admin = await insertUser(db, { role: 'admin' });
		const { event } = fakeEvent({
			url: 'https://ruby.example.com/admin/users?/invite',
			db,
			user: admin,
			form: { email: 'New@Example.test', role: 'member' }
		});
		const result = (await call(adminUsers.actions.invite, event)) as {
			invited: { link: string; email: string };
		};
		expect(result.invited.email).toBe('new@example.test');
		const token = result.invited.link.match(
			/^https:\/\/ruby\.example\.com\/invite\/([A-Za-z0-9_-]{43})$/
		)?.[1];
		expect(token).toBeTruthy();
		const page = await call(
			adminUsers.load,
			fakeEvent({ url: 'http://localhost/admin/users', db, user: admin }).event
		);
		expect(JSON.stringify(page)).not.toContain(token);
		expect(JSON.stringify(page)).not.toMatch(/token|hash/i);
		const accept = await call(
			invite.load,
			fakeEvent({ url: `http://localhost/invite/${token}`, db, params: { token: token! } }).event
		);
		expect(accept).toEqual({
			invite: { email: 'new@example.test', role: 'member' },
			signedInAs: null
		});
		expect(JSON.stringify(accept)).not.toContain(token);
	});
});
