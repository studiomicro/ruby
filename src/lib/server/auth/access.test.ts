import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	ACCESS_CLOCK_SKEW_S,
	ACCESS_NOT_CONFIGURED,
	accessConfig,
	accessRefusal,
	clearAccessKeyCache,
	JWKS_REFETCH_MIN_MS,
	JWKS_TTL_MS,
	verifyAccessJwt
} from './access';

/**
 * Cloudflare Access JWT verification against a generated RSA key and a stubbed JWKS fetch: nothing here reaches
 * Cloudflare.
 */

const TEAM = 'ruby-team.cloudflareaccess.com';
const AUD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';
const CONFIG = { teamDomain: TEAM, aud: AUD };
const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array | ArrayBuffer) =>
	Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString('base64url');
const jsonPart = (value: unknown) => b64url(enc.encode(JSON.stringify(value)));

interface KeyPair {
	kid: string;
	privateKey: CryptoKey;
	jwk: JsonWebKey & { kid: string };
}

async function makeKey(kid: string): Promise<KeyPair> {
	const pair = (await crypto.subtle.generateKey(
		{ ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
		true,
		['sign', 'verify']
	)) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
	return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

const goodClaims = () => ({
	aud: [AUD],
	iss: `https://${TEAM}`,
	email: 'dewi@example.test',
	sub: 'user-1',
	iat: NOW_S - 30,
	nbf: NOW_S - 30,
	exp: NOW_S + 3600
});

async function sign(
	key: KeyPair,
	claims: Record<string, unknown> = goodClaims(),
	header: Record<string, unknown> = { alg: 'RS256', kid: key.kid, typ: 'JWT' }
) {
	const signed = `${jsonPart(header)}.${jsonPart(claims)}`;
	const signature = await crypto.subtle.sign(RS256, key.privateKey, enc.encode(signed));
	return `${signed}.${b64url(signature)}`;
}

let main: KeyPair;
let other: KeyPair;
let rotated: KeyPair;

beforeAll(async () => {
	[main, other, rotated] = await Promise.all([
		makeKey('key-1'),
		makeKey('key-x'),
		makeKey('key-2')
	]);
});

/** A JWKS endpoint serving `keys()`; records each URL fetched. */
function jwks(keys: () => JsonWebKey[]) {
	const calls: string[] = [];
	const fetchFn = vi.fn(async (url: string) => {
		calls.push(url);
		return Response.json({ keys: keys(), public_cert: {}, public_certs: [] });
	});
	return { fetchFn, calls };
}

afterEach(() => {
	clearAccessKeyCache();
	vi.restoreAllMocks();
});

describe('verifyAccessJwt', () => {
	it('accepts a valid token and reads the JWKS from the team domain', async () => {
		const { fetchFn, calls } = jwks(() => [main.jwk]);
		const verdict = await verifyAccessJwt(await sign(main), CONFIG, NOW, fetchFn);
		expect(verdict).toEqual({ ok: true, email: 'dewi@example.test', sub: 'user-1' });
		expect(calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
	});

	it('accepts `aud` as a plain string too', async () => {
		const { fetchFn } = jwks(() => [main.jwk]);
		const token = await sign(main, { ...goodClaims(), aud: AUD });
		expect((await verifyAccessJwt(token, CONFIG, NOW, fetchFn)).ok).toBe(true);
	});

	it.each([
		['wrong aud', { aud: ['someone-elses-application-aud-tag'] }, 'audience'],
		['empty aud', { aud: [] }, 'audience'],
		['wrong iss', { iss: 'https://evil.cloudflareaccess.com' }, 'issuer'],
		['iss without scheme', { iss: TEAM }, 'issuer'],
		['expired', { exp: NOW_S - ACCESS_CLOCK_SKEW_S - 1 }, 'expired'],
		['no exp', { exp: undefined }, 'expired'],
		['not yet valid', { nbf: NOW_S + ACCESS_CLOCK_SKEW_S + 5 }, 'not_yet_valid']
	])('refuses %s', async (_, change, reason) => {
		const { fetchFn } = jwks(() => [main.jwk]);
		const token = await sign(main, { ...goodClaims(), ...change });
		expect(await verifyAccessJwt(token, CONFIG, NOW, fetchFn)).toEqual({ ok: false, reason });
	});

	it('allows up to 60 s of clock skew on exp and nbf', async () => {
		const { fetchFn } = jwks(() => [main.jwk]);
		const token = await sign(main, { ...goodClaims(), exp: NOW_S - 30, nbf: NOW_S + 30 });
		expect((await verifyAccessJwt(token, CONFIG, NOW, fetchFn)).ok).toBe(true);
	});

	it('refuses a bad signature: another key under the right kid, or a changed payload', async () => {
		const { fetchFn } = jwks(() => [main.jwk]);
		const forged = await sign({ ...other, kid: main.kid });
		expect(await verifyAccessJwt(forged, CONFIG, NOW, fetchFn)).toEqual({
			ok: false,
			reason: 'signature'
		});
		const [h, , s] = (await sign(main)).split('.');
		const tampered = `${h}.${jsonPart({ ...goodClaims(), email: 'boss@example.test' })}.${s}`;
		expect(await verifyAccessJwt(tampered, CONFIG, NOW, fetchFn)).toEqual({
			ok: false,
			reason: 'signature'
		});
	});

	it.each([
		['none', { alg: 'none', kid: 'key-1' }],
		['HS256', { alg: 'HS256', kid: 'key-1' }],
		['RS512', { alg: 'RS512', kid: 'key-1' }],
		['missing', { kid: 'key-1' }]
	])('refuses alg %s without fetching keys', async (_, header) => {
		const { fetchFn } = jwks(() => [main.jwk]);
		const unsigned = `${jsonPart(header)}.${jsonPart(goodClaims())}.`;
		expect(await verifyAccessJwt(unsigned, CONFIG, NOW, fetchFn)).toEqual({
			ok: false,
			reason: 'algorithm'
		});
		// An HS256 token "signed" with the public key as the HMAC secret gets the same answer.
		const hs = await sign(main, goodClaims(), header);
		expect(await verifyAccessJwt(hs, CONFIG, NOW, fetchFn)).toEqual({
			ok: false,
			reason: 'algorithm'
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it.each([
		['missing', undefined, 'missing'],
		['empty', '', 'missing'],
		['two parts', 'a.b', 'malformed'],
		['not base64url', 'a!.b.c', 'malformed'],
		['not JSON', `${b64url(enc.encode('x'))}.${b64url(enc.encode('y'))}.zz`, 'malformed'],
		['huge', 'a'.repeat(9000), 'malformed']
	])('refuses a %s token', async (_, token, reason) => {
		const { fetchFn } = jwks(() => [main.jwk]);
		expect(await verifyAccessJwt(token, CONFIG, NOW, fetchFn)).toEqual({ ok: false, reason });
	});

	it('caches keys for 10 minutes, then fetches again', async () => {
		const { fetchFn } = jwks(() => [main.jwk]);
		const token = await sign(main);
		await verifyAccessJwt(token, CONFIG, NOW, fetchFn);
		await verifyAccessJwt(token, CONFIG, NOW + JWKS_TTL_MS - 1, fetchFn);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		await verifyAccessJwt(token, CONFIG, NOW + JWKS_TTL_MS, fetchFn);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('refetches on an unknown kid (key rotation), at most once per interval', async () => {
		let served = [main.jwk];
		const { fetchFn } = jwks(() => served);
		expect((await verifyAccessJwt(await sign(main), CONFIG, NOW, fetchFn)).ok).toBe(true);
		served = [main.jwk, rotated.jwk];
		const next = await sign(rotated);
		// Right after a fetch an unknown kid is refused without another request (made-up kids cost nothing)…
		expect(await verifyAccessJwt(next, CONFIG, NOW + 1000, fetchFn)).toEqual({
			ok: false,
			reason: 'unknown_key'
		});
		expect(fetchFn).toHaveBeenCalledTimes(1);
		// …and once the interval has passed, the rotated key is fetched and accepted.
		expect((await verifyAccessJwt(next, CONFIG, NOW + JWKS_REFETCH_MIN_MS, fetchFn)).ok).toBe(true);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		// A kid the JWKS does not hold even after the refetch is refused.
		const stranger = await sign({ ...other, kid: 'key-unknown' });
		expect(await verifyAccessJwt(stranger, CONFIG, NOW + 2 * JWKS_REFETCH_MIN_MS, fetchFn)).toEqual(
			{
				ok: false,
				reason: 'unknown_key'
			}
		);
	});

	it('fails closed when the JWKS cannot be fetched or holds no usable key', async () => {
		const token = await sign(main);
		const down = vi.fn(async () => new Response('nope', { status: 500 }));
		expect(await verifyAccessJwt(token, CONFIG, NOW, down)).toEqual({
			ok: false,
			reason: 'jwks_unavailable'
		});
		const throws = vi.fn(async () => {
			throw new Error('network');
		});
		expect(await verifyAccessJwt(token, CONFIG, NOW, throws)).toEqual({
			ok: false,
			reason: 'jwks_unavailable'
		});
		const hmacOnly = jwks(() => [{ kty: 'oct', k: 'c2VjcmV0', kid: 'key-1' } as JsonWebKey]);
		expect(await verifyAccessJwt(token, CONFIG, NOW, hmacOnly.fetchFn)).toEqual({
			ok: false,
			reason: 'jwks_unavailable'
		});
	});
});

describe('accessConfig', () => {
	it('reads both vars, tolerating a scheme and trailing slash on the team domain', () => {
		expect(accessConfig({ ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, ACCESS_AUD: AUD })).toEqual(
			CONFIG
		);
	});
	it.each([
		[{}],
		[{ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' }],
		[{ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: '' }],
		[{ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: AUD }],
		[{ ACCESS_TEAM_DOMAIN: 'not a host', ACCESS_AUD: AUD }],
		[{ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: 'short' }]
	])('is null for %j', (env) => expect(accessConfig(env)).toBeNull());
});

describe('accessRefusal', () => {
	const request = (token?: string) =>
		new Request('https://ruby.example.com/', {
			headers: token ? { 'cf-access-jwt-assertion': token } : {}
		});
	const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

	it('is null for a valid JWT, 403 without one, 503 while unconfigured', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { fetchFn } = jwks(() => [main.jwk]);
		expect(await accessRefusal(request(await sign(main)), env, NOW, fetchFn)).toBeNull();
		const missing = await accessRefusal(request(), env, NOW, fetchFn);
		expect(missing?.status).toBe(403);
		const unconfigured = await accessRefusal(
			request(await sign(main)),
			{ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' },
			NOW,
			fetchFn
		);
		expect(unconfigured?.status).toBe(503);
		expect(await unconfigured?.text()).toBe(ACCESS_NOT_CONFIGURED);
	});

	it('logs the reason only, never the token', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { fetchFn } = jwks(() => [main.jwk]);
		const token = await sign(main, { ...goodClaims(), aud: ['other-application-aud-tag'] });
		expect((await accessRefusal(request(token), env, NOW, fetchFn))?.status).toBe(403);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(token.slice(0, 20));
		expect(warn).toHaveBeenCalledWith('access: refused', 'audience');
	});
});
