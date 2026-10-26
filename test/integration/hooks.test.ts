import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clearAccessKeyCache } from '#lib/server/auth/access';
import { sessionCookieName } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { insertSession, insertUser } from '../helpers/users';

/**
 * hooks.server.ts end to end with a stubbed `resolve`: the order CSRF → https → Cloudflare Access → session gate,
 * the Access policy on a deployed host (503 unconfigured, 403 without a valid JWT) and its absence on localhost,
 * and the headers every response carries. The JWKS is a stubbed `fetch`; nothing reaches Cloudflare.
 */

const binding: {
	DB?: D1Database;
	ACCESS_TEAM_DOMAIN: string;
	ACCESS_AUD: string;
	ACCESS_DISABLED?: string;
} = {
	ACCESS_TEAM_DOMAIN: '',
	ACCESS_AUD: ''
};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const { handle } = await import('../../src/hooks.server');

const TEAM = 'ruby-team.cloudflareaccess.com';
const AUD = 'f00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeed';
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const b64url = (b: ArrayBuffer | Uint8Array) =>
	Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString('base64url');

let db: Db;
let dispose: () => Promise<void>;
let keys: CryptoKeyPair;
let jwk: JsonWebKey;

beforeAll(async () => {
	const opened = await openLocalD1();
	binding.DB = opened.db;
	db = getDb(opened.db);
	dispose = opened.dispose;
	keys = (await crypto.subtle.generateKey(
		{ ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
		true,
		['sign', 'verify']
	)) as CryptoKeyPair;
	jwk = {
		...(await crypto.subtle.exportKey('jwk', keys.publicKey)),
		kid: 'k1',
		alg: 'RS256'
	} as JsonWebKey;
});
afterAll(() => dispose());
afterEach(() => {
	binding.ACCESS_TEAM_DOMAIN = '';
	binding.ACCESS_AUD = '';
	delete binding.ACCESS_DISABLED;
	clearAccessKeyCache();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function configureAccess() {
	binding.ACCESS_TEAM_DOMAIN = TEAM;
	binding.ACCESS_AUD = AUD;
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({ keys: [jwk] }))
	);
}

async function accessJwt(claims: Record<string, unknown> = {}) {
	const now = Math.floor(Date.now() / 1000);
	const part = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));
	const signed = `${part({ alg: 'RS256', kid: 'k1' })}.${part({ aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, ...claims })}`;
	const sig = await crypto.subtle.sign(RS256, keys.privateKey, new TextEncoder().encode(signed));
	return `${signed}.${b64url(sig)}`;
}

const resolve = vi.fn(
	async () => new Response('<p>page</p>', { headers: { 'content-type': 'text/html' } })
);

async function run(init: Parameters<typeof fakeEvent>[0]) {
	const { event } = fakeEvent(init);
	resolve.mockClear();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const response = await handle({ event, resolve } as never);
	return { response, event };
}

function expectSecurityHeaders(response: Response) {
	expect(response.headers.get('x-robots-tag')).toBe('noindex');
	expect(response.headers.get('strict-transport-security')).toMatch(/max-age=/);
	expect(response.headers.get('x-content-type-options')).toBe('nosniff');
}

describe('Cloudflare Access on a deployed host', () => {
	it('answers 503 while ACCESS_TEAM_DOMAIN / ACCESS_AUD are empty (fail closed), before any route runs', async () => {
		const { response } = await run({
			url: 'https://ruby.example.com/login',
			routeId: '/(auth)/login',
			db
		});
		expect(response.status).toBe(503);
		expect(await response.text()).toBe('Cloudflare Access is not configured for this deployment.');
		expectSecurityHeaders(response);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('skips the Access check only when ACCESS_DISABLED is exactly "1"', async () => {
		for (const value of ['true', '0', 'yes', ' 1', '']) {
			binding.ACCESS_DISABLED = value;
			const { response } = await run({
				url: 'https://ruby.example.com/login',
				routeId: '/(auth)/login',
				db
			});
			expect(response.status).toBe(503);
		}
		binding.ACCESS_DISABLED = '1';
		const { response } = await run({
			url: 'https://ruby.example.com/login',
			routeId: '/(auth)/login',
			db
		});
		expect(response.status).toBe(200);
		expect(resolve).toHaveBeenCalledTimes(1);
		expectSecurityHeaders(response);
	});

	it('answers 403 without a JWT, with a wrong-audience JWT and with an expired one', async () => {
		configureAccess();
		for (const headers of <Record<string, string>[]>[
			{},
			{ 'cf-access-jwt-assertion': await accessJwt({ aud: ['other-app-aud-tag-0001'] }) },
			{ 'cf-access-jwt-assertion': await accessJwt({ exp: Math.floor(Date.now() / 1000) - 3600 }) },
			{ 'cf-access-jwt-assertion': 'not.a.jwt' }
		]) {
			const { response } = await run({
				url: 'https://ruby.example.com/',
				routeId: '/(app)',
				db,
				headers
			});
			expect(response.status).toBe(403);
			expectSecurityHeaders(response);
		}
		expect(resolve).not.toHaveBeenCalled();
	});

	it('ignores the unsigned identity header', async () => {
		configureAccess();
		const { response } = await run({
			url: 'https://ruby.example.com/login',
			routeId: '/(auth)/login',
			db,
			headers: { 'cf-access-authenticated-user-email': 'boss@example.test' }
		});
		expect(response.status).toBe(403);
	});

	it('lets a valid JWT through to the session gate (signed out → /login?next=)', async () => {
		configureAccess();
		const jwt = await accessJwt();
		const { response } = await run({
			url: 'https://ruby.example.com/projects?view=board',
			routeId: '/(app)/projects',
			db,
			headers: { 'cf-access-jwt-assertion': jwt }
		});
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/login?next=%2Fprojects%3Fview%3Dboard');
		expectSecurityHeaders(response);
		const login = await run({
			url: 'https://ruby.example.com/login',
			routeId: '/(auth)/login',
			db,
			headers: { 'cf-access-jwt-assertion': jwt }
		});
		expect(login.response.status).toBe(200);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('checks Access before the session: a valid session cookie without a JWT is still 403', async () => {
		configureAccess();
		const user = await insertUser(db);
		const token = await insertSession(db, user.id);
		const { response } = await run({
			url: 'https://ruby.example.com/',
			routeId: '/(app)',
			db,
			cookies: { [sessionCookieName(true)]: token }
		});
		expect(response.status).toBe(403);
	});

	it('signed in through Access and a session: the page, private and uncached', async () => {
		configureAccess();
		const user = await insertUser(db);
		const token = await insertSession(db, user.id);
		const { response, event } = await run({
			url: 'https://ruby.example.com/',
			routeId: '/(app)',
			db,
			cookies: { [sessionCookieName(true)]: token },
			headers: { 'cf-access-jwt-assertion': await accessJwt() }
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(event.locals.user?.id).toBe(user.id);
		expect(event.locals.secure).toBe(true);
	});

	it('redirects plain http to https before Access or cookies', async () => {
		const { response } = await run({
			url: 'http://ruby.example.com/kb?x=1',
			routeId: '/(app)/kb',
			db
		});
		expect(response.status).toBe(308);
		expect(response.headers.get('location')).toBe('https://ruby.example.com/kb?x=1');
		expectSecurityHeaders(response);
	});
});

describe('local dev (loopback host)', () => {
	it('skips Access entirely, even with the vars empty', async () => {
		const { response } = await run({
			url: 'http://localhost:5173/login',
			routeId: '/(auth)/login',
			db
		});
		expect(response.status).toBe(200);
		expect(resolve).toHaveBeenCalledTimes(1);
		expectSecurityHeaders(response);
	});

	it('uses the plain cookie name and sends signed-out (app) requests to /login', async () => {
		const user = await insertUser(db);
		const token = await insertSession(db, user.id);
		const signedIn = await run({
			url: 'http://localhost:5173/',
			routeId: '/(app)',
			db,
			cookies: { ruby_session: token }
		});
		expect(signedIn.response.status).toBe(200);
		const signedOut = await run({
			url: 'http://localhost:5173/account',
			routeId: '/(app)/account',
			db
		});
		expect(signedOut.response.status).toBe(303);
		expect(signedOut.response.headers.get('location')).toBe('/login?next=%2Faccount');
		const post = await run({
			url: 'http://localhost:5173/account?/name',
			routeId: '/(app)/account',
			db,
			form: { name: 'x' }
		});
		expect(post.response.status).toBe(401);
	});
});

describe('the rest of the pipeline', () => {
	it('refuses a cross-site form POST first, with the security headers', async () => {
		const { response } = await run({
			url: 'https://ruby.example.com/login',
			routeId: '/(auth)/login',
			db,
			form: { email: 'a@b.test' },
			headers: { origin: 'https://evil.example' }
		});
		expect(response.status).toBe(403);
		expect(await response.text()).toBe('Cross-site POST form submissions are forbidden');
		expectSecurityHeaders(response);
	});

	it('logs the route id, or the path with an invite token redacted, never the query', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { event } = fakeEvent({
			url: 'http://localhost/invite/SECRETTOKENabc123?next=/x',
			routeId: null,
			db
		});
		await handle({ event, resolve } as never);
		const line = JSON.stringify(log.mock.calls);
		expect(line).toContain('/invite/[token]');
		expect(line).not.toContain('SECRETTOKEN');
		expect(line).not.toContain('next=');
	});

	it('gives invite pages a strict-origin referrer policy', async () => {
		const { response } = await run({
			url: 'http://localhost/invite/abc',
			routeId: '/(auth)/invite/[token]',
			db
		});
		expect(response.headers.get('referrer-policy')).toBe('strict-origin');
	});
});
