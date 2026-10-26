/**
 * Cloudflare Access, the first of Ruby's two gates (CLAUDE.md › Access and auth). Access sits in front of
 * ruby.example.com and adds a signed `Cf-Access-Jwt-Assertion` header to every request it lets through; the Worker
 * verifies that JWT itself, so a request that reached the Worker some other way (a misrouted hostname, an Access
 * application switched off) is refused instead of trusted. Unsigned identity headers (`Cf-Access-Authenticated-
 * User-Email`) are never read.
 *
 * Verification follows https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/:
 * RS256 only (the algorithm is pinned here, never taken from the token), the key from the team's JWKS at
 * `https://<team>/cdn-cgi/access/certs` chosen by `kid`, `aud` containing ACCESS_AUD, `iss` equal to
 * `https://<team>`, and `exp`/`nbf` with at most ACCESS_CLOCK_SKEW_S of clock skew. WebCrypto only.
 */

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
/** How long fetched signing keys are reused before the JWKS is fetched again. */
export const JWKS_TTL_MS = 10 * 60 * 1000;
/**
 * The shortest gap between two JWKS fetches caused by an unknown `kid` (Cloudflare rotates keys every six weeks and
 * publishes the next one ahead): a stream of made-up `kid`s costs at most one fetch per this interval.
 */
export const JWKS_REFETCH_MIN_MS = 30 * 1000;
/**
 * After a failed JWKS fetch, requests that need a fetch are answered 'jwks_unavailable' for this long without
 * fetching again, so an outage of the endpoint costs one fetch per interval instead of one (and up to
 * JWKS_TIMEOUT_MS of waiting) per request.
 */
export const JWKS_FAILURE_BACKOFF_MS = 10 * 1000;
export const ACCESS_CLOCK_SKEW_S = 60;
/** Far above any real Access JWT (about 1 KB); a longer header is refused before any parsing. */
const JWT_MAX_LENGTH = 8 * 1024;
/** Far above what a JWKS holds (two or three keys); extra entries are ignored. */
const JWKS_MAX_KEYS = 16;
const JWKS_TIMEOUT_MS = 5_000;

export type AccessFailure =
	| 'missing'
	| 'malformed'
	| 'algorithm'
	| 'unknown_key'
	| 'signature'
	| 'audience'
	| 'issuer'
	| 'expired'
	| 'not_yet_valid'
	| 'jwks_unavailable';

export type AccessVerdict =
	{ ok: true; email: string | null; sub: string | null } | { ok: false; reason: AccessFailure };

export interface AccessConfig {
	/** `<team>.cloudflareaccess.com` (a scheme or trailing slash is tolerated and dropped). */
	teamDomain: string;
	/** The Access application's audience tag. */
	aud: string;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const AUD = /^[0-9A-Za-z_-]{8,200}$/;

/**
 * The Access settings of this Worker, or null when either is missing or malformed: on a deployed host the hook then
 * answers 503 for every request (fail closed), never skips the check.
 */
export function accessConfig(env: {
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
}): AccessConfig | null {
	const teamDomain = String(env.ACCESS_TEAM_DOMAIN ?? '')
		.trim()
		.toLowerCase()
		.replace(/^https:\/\//, '')
		.replace(/\/+$/, '');
	const aud = String(env.ACCESS_AUD ?? '').trim();
	if (!HOSTNAME.test(teamDomain) || !AUD.test(aud)) return null;
	return { teamDomain, aud };
}

interface KeySet {
	keys: Map<string, CryptoKey>;
	fetchedAt: number;
}

/** Module-scope JWKS cache, one entry per team domain (one per Worker isolate). */
const keyCache = new Map<string, KeySet>();
/**
 * The JWKS fetch in flight per team domain: concurrent requests share it (single flight). One older than
 * JWKS_STALE_FLIGHT_MS is no longer shared, so a fetch that never settles cannot block the team's later fetches.
 */
const inFlight = new Map<
	string,
	{ promise: Promise<Map<string, CryptoKey> | null>; startedAt: number }
>();
const JWKS_STALE_FLIGHT_MS = JWKS_TIMEOUT_MS + 1_000;
/** When the last JWKS fetch per team domain failed (cleared by a successful one). */
const failedAt = new Map<string, number>();

/** Test hook: forget every cached key set, fetch in flight and remembered failure. */
export function clearAccessKeyCache(): void {
	keyCache.clear();
	inFlight.clear();
	failedAt.clear();
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

/** The RSA signing keys of the JWKS at `url`; null when it cannot be fetched or holds none. */
async function fetchKeys(url: string, fetchFn: FetchLike): Promise<Map<string, CryptoKey> | null> {
	let body: unknown;
	try {
		const response = await fetchFn(url, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(JWKS_TIMEOUT_MS)
		});
		if (!response.ok) return null;
		body = await response.json();
	} catch {
		return null;
	}
	const list = (body as { keys?: unknown })?.keys;
	if (!Array.isArray(list)) return null;
	const keys = new Map<string, CryptoKey>();
	for (const jwk of list.slice(0, JWKS_MAX_KEYS) as Record<string, unknown>[]) {
		if (typeof jwk !== 'object' || jwk === null) continue;
		if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || typeof jwk.n !== 'string') continue;
		if (jwk.use !== undefined && jwk.use !== 'sig') continue;
		if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
		try {
			const key = await crypto.subtle.importKey(
				'jwk',
				{ kty: 'RSA', n: jwk.n, e: String(jwk.e ?? ''), alg: 'RS256', ext: true },
				RS256,
				false,
				['verify']
			);
			keys.set(jwk.kid, key);
		} catch {
			// A key WebCrypto refuses is skipped; the others still count.
		}
	}
	return keys.size > 0 ? keys : null;
}

/**
 * The team's key set from one JWKS fetch, shared by every request that asks while it is in flight. The outcome is
 * recorded once: a key set goes into the cache, a failure into `failedAt`.
 */
function sharedFetch(teamDomain: string, now: number, fetchFn: FetchLike) {
	const current = inFlight.get(teamDomain);
	if (current && now - current.startedAt < JWKS_STALE_FLIGHT_MS) return current.promise;
	const flight = {
		startedAt: now,
		promise: fetchKeys(`https://${teamDomain}/cdn-cgi/access/certs`, fetchFn).then((keys) => {
			if (keys) {
				keyCache.set(teamDomain, { keys, fetchedAt: now });
				failedAt.delete(teamDomain);
			} else {
				failedAt.set(teamDomain, now);
			}
			// A stale flight settling late leaves a newer one in place.
			if (inFlight.get(teamDomain) === flight) inFlight.delete(teamDomain);
			return keys;
		})
	};
	inFlight.set(teamDomain, flight);
	return flight.promise;
}

/**
 * The key for `kid`: from the cache while it is younger than JWKS_TTL_MS, else (or when `kid` is unknown and the
 * last fetch is at least JWKS_REFETCH_MIN_MS old) from a fresh fetch, one per team domain at a time. Within
 * JWKS_FAILURE_BACKOFF_MS of a failed fetch nothing is fetched. 'unavailable' when no key set can be had.
 */
async function signingKey(
	teamDomain: string,
	kid: string,
	now: number,
	fetchFn: FetchLike
): Promise<CryptoKey | 'unknown' | 'unavailable'> {
	const cached = keyCache.get(teamDomain);
	const fresh = cached !== undefined && now - cached.fetchedAt < JWKS_TTL_MS;
	const hit = fresh ? cached.keys.get(kid) : undefined;
	if (hit) return hit;
	if (fresh && now - cached.fetchedAt < JWKS_REFETCH_MIN_MS) return 'unknown';
	const failed = failedAt.get(teamDomain);
	if (failed !== undefined && now - failed < JWKS_FAILURE_BACKOFF_MS && !inFlight.has(teamDomain))
		return 'unavailable';
	const keys = await sharedFetch(teamDomain, now, fetchFn);
	// A failed refresh keeps a still-fresh key set (a key it holds was accepted above; nothing new is learnt).
	if (!keys) return 'unavailable';
	return keys.get(kid) ?? 'unknown';
}

/** base64url → bytes; null for anything that is not base64url. */
function fromBase64Url(part: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]*$/.test(part)) return null;
	try {
		const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
		return Uint8Array.from(bin, (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

function jsonPart(part: string): Record<string, unknown> | null {
	const bytes = fromBase64Url(part);
	if (!bytes) return null;
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * Verifies one Access JWT against `config` at `now` (milliseconds). `fetchFn` fetches the JWKS (tests stub it).
 * Checks run cheapest first; the signature is checked before any claim is trusted.
 */
export async function verifyAccessJwt(
	token: string | null | undefined,
	config: AccessConfig,
	now: number,
	fetchFn: FetchLike = fetch
): Promise<AccessVerdict> {
	if (!token) return { ok: false, reason: 'missing' };
	if (token.length > JWT_MAX_LENGTH) return { ok: false, reason: 'malformed' };
	const parts = token.split('.');
	if (parts.length !== 3) return { ok: false, reason: 'malformed' };
	const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
	const header = jsonPart(headerPart);
	const payload = jsonPart(payloadPart);
	const signature = fromBase64Url(signaturePart);
	if (!header || !payload || !signature) return { ok: false, reason: 'malformed' };
	if (header.alg !== 'RS256') return { ok: false, reason: 'algorithm' };
	if (typeof header.kid !== 'string' || header.kid.length === 0 || header.kid.length > 200)
		return { ok: false, reason: 'unknown_key' };

	const key = await signingKey(config.teamDomain, header.kid, now, fetchFn);
	if (key === 'unavailable') return { ok: false, reason: 'jwks_unavailable' };
	if (key === 'unknown') return { ok: false, reason: 'unknown_key' };
	const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
	const valid = await crypto.subtle.verify(RS256, key, signature, signed).catch(() => false);
	if (!valid) return { ok: false, reason: 'signature' };

	const aud = payload.aud;
	const audiences = Array.isArray(aud) ? aud : [aud];
	if (!audiences.some((a) => a === config.aud)) return { ok: false, reason: 'audience' };
	if (payload.iss !== `https://${config.teamDomain}`) return { ok: false, reason: 'issuer' };
	const seconds = now / 1000;
	if (typeof payload.exp !== 'number' || payload.exp + ACCESS_CLOCK_SKEW_S <= seconds)
		return { ok: false, reason: 'expired' };
	if (
		payload.nbf !== undefined &&
		(typeof payload.nbf !== 'number' || payload.nbf - ACCESS_CLOCK_SKEW_S > seconds)
	)
		return { ok: false, reason: 'not_yet_valid' };
	return {
		ok: true,
		email: typeof payload.email === 'string' ? payload.email : null,
		sub: typeof payload.sub === 'string' ? payload.sub : null
	};
}

const plain = (status: number, text: string) =>
	new Response(text, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
	});

export const ACCESS_NOT_CONFIGURED = 'Cloudflare Access is not configured for this deployment.';
export const ACCESS_DENIED = 'Access denied. Open Ruby through Cloudflare Access.';
export const ACCESS_UNAVAILABLE = 'Cloudflare Access keys could not be loaded. Try again shortly.';

/**
 * The hook's Access policy for a request to a deployed host: null when the request carries a valid Access JWT,
 * else the plain-text refusal — 503 while the Access vars are unset or malformed and while the JWKS cannot be
 * fetched, 403 for a missing or invalid JWT. Logs the reason label only, never the token or its claims.
 */
export async function accessRefusal(
	request: Request,
	env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string },
	now: number,
	fetchFn: FetchLike = fetch
): Promise<Response | null> {
	const config = accessConfig(env);
	if (!config) {
		console.error('access: not configured');
		return plain(503, ACCESS_NOT_CONFIGURED);
	}
	const verdict = await verifyAccessJwt(
		request.headers.get(ACCESS_JWT_HEADER),
		config,
		now,
		fetchFn
	);
	if (verdict.ok) return null;
	console.warn('access: refused', verdict.reason);
	return verdict.reason === 'jwks_unavailable'
		? plain(503, ACCESS_UNAVAILABLE)
		: plain(403, ACCESS_DENIED);
}
