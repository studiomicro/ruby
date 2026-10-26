import { and, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { authAttempts } from '../db/schema';
import { sha256Hex } from '../util';

/**
 * Per-client and per-user throttle. Account lockout (password.ts) stops guessing at one account; this stops one client spraying
 * many accounts, burning key derivations or flooding a write path. The stored key is a SHA-256 of the scope and
 * client (or user id), so no address is kept; a window's row is replaced once it expires.
 */
export const THROTTLE_WINDOW_MS = 10 * 60 * 1000;
/** The default budget per window of a per-user scope (overUserAttemptLimit). */
export const THROTTLE_MAX_ATTEMPTS = 20;
/**
 * The budget per window of a per-client scope (overAttemptLimit: `sign-in`, `setup`, `invite-accept`). A whole
 * office behind one NAT address shares it, so it is generous: it caps a flood of key derivations, while guessing at
 * one account is stopped by that account's lockout (password.ts › PASSWORD_MAX_FAILURES).
 */
export const CLIENT_MAX_ATTEMPTS = 100;

/**
 * Every budget, each counted on its own:
 * - per client (overAttemptLimit): `sign-in`, `setup`, `invite-accept` — before any key derivation;
 * - per user (overUserAttemptLimit): `account-password` (the account page's password proof), and for the features
 *   built on this foundation `upload` (RB-04), `comment-create` (RB-03), `search` (RB-02), and `hr-reveal` and
 *   `hr-export` (RB-05), `leave-request` (RB-06), each with the `max` its PRD names, and the mention picker's
 *   `mention-search` (RB-03, a one-minute budget only) and Report an issue's `issue-report` (RB-12, 20 a minute), and `bulk-edit` (RB-12, 30 bulk requests per
 *   10 minutes on the project list and the Issues page together).
 */
export const THROTTLE_SCOPES = [
	'sign-in',
	'setup',
	'invite-accept',
	'account-password',
	'upload',
	'comment-create',
	'search',
	'mention-search',
	'hr-reveal',
	'hr-export',
	'leave-request',
	'issue-report',
	'bulk-edit'
] as const;
export type ThrottleScope = (typeof THROTTLE_SCOPES)[number];

/**
 * The short window of a per-minute budget (overUserMinuteLimit), counted next to a scope's 10-minute one so a
 * burst cannot spend a whole window's budget at once (RB-02 `search`: 30 a minute and 300 per 10 minutes).
 */
export const THROTTLE_MINUTE_MS = 60 * 1000;

/** Seconds until the current budget window (`windowMs`, 10 minutes by default) ends: the `Retry-After` of a 429. */
export const retryAfterSeconds = (now: number, windowMs = THROTTLE_WINDOW_MS) =>
	Math.ceil((windowMs - (now % windowMs)) / 1000);

/**
 * The /64 an IPv6 address belongs to, written `a:b:c:d::/64`: one host usually holds a whole /64, so keying by the
 * full address would let it rotate through 2^64 budgets. An IPv4-mapped address gives its IPv4 address. Null when
 * `ip` is not an IPv6 address.
 */
export function ipv6Prefix(ip: string): string | null {
	const addr = (ip.split('%')[0] ?? '').toLowerCase();
	if (!addr.includes(':') || addr.length > 45) return null;
	const halves = addr.split('::');
	if (halves.length > 2) return null;
	const groups = (part: string) => (part ? part.split(':') : []);
	const head = groups(halves[0] ?? '');
	const tail = groups(halves[1] ?? '');
	// A trailing dotted IPv4 part stands for the last two groups.
	const lastList = tail.length ? tail : head;
	const last = lastList.at(-1) ?? '';
	if (last.includes('.')) {
		const parts = last.split('.');
		if (parts.length !== 4 || !parts.every((o) => /^\d{1,3}$/.test(o) && Number(o) < 256))
			return null;
		const v4 = parts.map(Number) as [number, number, number, number];
		lastList.splice(
			-1,
			1,
			((v4[0] << 8) | v4[1]).toString(16),
			((v4[2] << 8) | v4[3]).toString(16)
		);
	}
	const given = head.length + tail.length;
	if (halves.length === 2 ? given > 7 : given !== 8) return null;
	const all = [...head, ...Array<string>(8 - given).fill('0'), ...tail];
	if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
	const n = all.map((g) => parseInt(g, 16));
	if (n.slice(0, 5).every((g) => g === 0) && n[5] === 0xffff) {
		const a = n[6] ?? 0;
		const b = n[7] ?? 0;
		return [a >> 8, a & 255, b >> 8, b & 255].join('.');
	}
	return `${n
		.slice(0, 4)
		.map((g) => g.toString(16))
		.join(':')}::/64`;
}

/**
 * The client a request counts against. Cloudflare always sets CF-Connecting-IP (a client cannot override it); the
 * other headers are fallbacks for local runs only. An IPv6 client counts by its /64.
 */
export function clientKey(request: Request): string {
	const h = request.headers;
	const ip =
		h.get('cf-connecting-ip') ??
		h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
		h.get('x-real-ip') ??
		'unknown';
	return ipv6Prefix(ip) ?? ip;
}

/**
 * One attempt against the budget named `name` in windows of `windowMs` (at most THROTTLE_WINDOW_MS); true when it
 * is over `max`. At most three small guarded statements.
 * Concurrent first attempts all miss the UPDATE and land on the upsert, which counts them instead of each resetting
 * the window to 1; a late request whose clock was read before a newer window began counts in that newer window and
 * never moves the row back.
 */
export async function countAttempt(
	db: Db,
	name: string,
	now: number,
	max = THROTTLE_MAX_ATTEMPTS,
	windowMs = THROTTLE_WINDOW_MS
): Promise<boolean> {
	const key = await sha256Hex(name);
	const windowStart = now - (now % windowMs);
	const updated = await db
		.update(authAttempts)
		.set({ count: sql`${authAttempts.count} + 1` })
		.where(and(eq(authAttempts.clientHash, key), eq(authAttempts.windowStart, windowStart)))
		.returning({ count: authAttempts.count });
	if (updated[0]) return updated[0].count > max;
	// First attempt of this window for this key: rare, so the cleanup of expired windows rides along here. Only rows
	// older than the longest window go: a short window's start must not clear a 10-minute window still running.
	await db.delete(authAttempts).where(lt(authAttempts.windowStart, now - THROTTLE_WINDOW_MS));
	const [row] = await db
		.insert(authAttempts)
		.values({ clientHash: key, windowStart, count: 1 })
		.onConflictDoUpdate({
			target: authAttempts.clientHash,
			set: {
				count: sql`case when ${authAttempts.windowStart} >= ${windowStart} then ${authAttempts.count} + 1 else 1 end`,
				windowStart: sql`max(${authAttempts.windowStart}, ${windowStart})`
			}
		})
		.returning({ count: authAttempts.count });
	return (row?.count ?? 1) > max;
}

/**
 * Every scope fails CLOSED: when D1 cannot count the attempt, it is treated as over the limit (logged with the
 * scope and error class only). Each counted action needs the same database right after, so a refusal costs nothing
 * a working database would have allowed, and a partial failure never opens an unthrottled path.
 */
function failClosed(scope: ThrottleScope, e: unknown): true {
	console.error('throttle unavailable', scope, e instanceof Error ? e.name : typeof e);
	return true;
}

/**
 * Counts one attempt of `scope` for this request's client, before any key derivation, so a flood costs one indexed
 * row read and write. The budget is CLIENT_MAX_ATTEMPTS unless `max` names another. A database failure refuses the
 * attempt (failClosed).
 */
export async function overAttemptLimit(
	db: Db,
	request: Request,
	now: number,
	scope: ThrottleScope,
	max = CLIENT_MAX_ATTEMPTS
): Promise<boolean> {
	try {
		return await countAttempt(db, `${scope}:${clientKey(request)}`, now, max);
	} catch (e) {
		return failClosed(scope, e);
	}
}

/**
 * Counts one attempt of `scope` against the signed-in user `userId` (not the client): a session holder rotating
 * addresses still has one budget. Fails closed like overAttemptLimit.
 */
export async function overUserAttemptLimit(
	db: Db,
	userId: string,
	now: number,
	scope: ThrottleScope,
	max = THROTTLE_MAX_ATTEMPTS
): Promise<boolean> {
	try {
		return await countAttempt(db, `${scope}:user:${userId}`, now, max);
	} catch (e) {
		return failClosed(scope, e);
	}
}

/**
 * Counts one attempt of `scope` against `userId` in a one-minute window (THROTTLE_MINUTE_MS), a budget of its own
 * next to overUserAttemptLimit's 10-minute one. Fails closed like overAttemptLimit.
 */
export async function overUserMinuteLimit(
	db: Db,
	userId: string,
	now: number,
	scope: ThrottleScope,
	max: number
): Promise<boolean> {
	try {
		return await countAttempt(db, `${scope}:user:${userId}:minute`, now, max, THROTTLE_MINUTE_MS);
	} catch (e) {
		return failClosed(scope, e);
	}
}
