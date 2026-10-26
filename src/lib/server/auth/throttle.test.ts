import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openLocalD1 } from '../../../../test/helpers/d1';
import { getDb, type Db } from '../db';
import {
	CLIENT_MAX_ATTEMPTS,
	clientKey,
	ipv6Prefix,
	overAttemptLimit,
	overUserAttemptLimit,
	THROTTLE_MAX_ATTEMPTS,
	THROTTLE_SCOPES,
	THROTTLE_WINDOW_MS
} from './throttle';

describe('ipv6Prefix', () => {
	it.each([
		['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
		['2001:DB8:1:2::1', '2001:db8:1:2::/64'],
		['::ffff:203.0.113.9', '203.0.113.9'],
		['fe80::1%eth0', 'fe80:0:0:0::/64']
	])('%s → %s', (ip, want) => expect(ipv6Prefix(ip)).toBe(want));

	it.each(['203.0.113.9', 'unknown', '1:2:3:4:5:6:7:8:9', '1::2::3', 'zz::1'])(
		'%s is not IPv6',
		(ip) => expect(ipv6Prefix(ip)).toBeNull()
	);
});

describe('clientKey', () => {
	const req = (h: Record<string, string>) => new Request('http://localhost/', { headers: h });
	it('prefers CF-Connecting-IP over the spoofable fallbacks', () => {
		expect(
			clientKey(req({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1' }))
		).toBe('203.0.113.9');
	});
	it('keys IPv6 clients by /64', () => {
		expect(clientKey(req({ 'cf-connecting-ip': '2001:db8:1:2:aaaa::1' }))).toBe(
			clientKey(req({ 'cf-connecting-ip': '2001:db8:1:2:bbbb::9' }))
		);
	});
	it('falls back to the first X-Forwarded-For entry, then "unknown"', () => {
		expect(clientKey(req({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }))).toBe('198.51.100.1');
		expect(clientKey(req({}))).toBe('unknown');
	});
});

describe('every scope the features need exists', () => {
	it('lists the foundation and feature budgets', () => {
		expect([...THROTTLE_SCOPES].sort()).toEqual(
			[
				'account-password',
				'comment-create',
				'hr-export',
				'hr-reveal',
				'invite-accept',
				'leave-request',
				'mention-search',
				'search',
				'setup',
				'sign-in',
				'upload'
			].sort()
		);
	});
});

describe('throttle on a database error', () => {
	const broken = getDb({
		prepare: () => {
			throw new Error('D1_ERROR: unavailable');
		},
		batch: () => Promise.reject(new Error('D1_ERROR: unavailable'))
	} as unknown as D1Database);
	const request = new Request('http://localhost/', {
		headers: { 'cf-connecting-ip': '203.0.113.9' }
	});

	it.each(THROTTLE_SCOPES)(
		'%s fails closed: the attempt counts as over the limit',
		async (scope) => {
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			expect(await overAttemptLimit(broken, request, 1_800_000_000_000, scope)).toBe(true);
			expect(await overUserAttemptLimit(broken, 'u1', 1_800_000_000_000, scope)).toBe(true);
			expect(log).toHaveBeenCalled();
			log.mockRestore();
		}
	);
});

describe('throttle counting (local D1)', () => {
	let db: Db;
	let dispose: () => Promise<void>;
	beforeAll(async () => {
		const opened = await openLocalD1();
		db = getDb(opened.db);
		dispose = opened.dispose;
	});
	afterAll(() => dispose());

	const at = 1_800_000_000_000 - (1_800_000_000_000 % THROTTLE_WINDOW_MS);
	const from = (ip: string) =>
		new Request('http://localhost/', { headers: { 'cf-connecting-ip': ip } });

	it('allows max attempts per window, refuses the next, and starts over in the next window', async () => {
		for (let i = 0; i < CLIENT_MAX_ATTEMPTS; i++)
			expect(await overAttemptLimit(db, from('198.51.100.7'), at + i, 'sign-in')).toBe(false);
		expect(await overAttemptLimit(db, from('198.51.100.7'), at + 100, 'sign-in')).toBe(true);
		// Another scope and another client have their own budgets.
		expect(await overAttemptLimit(db, from('198.51.100.7'), at + 100, 'setup')).toBe(false);
		expect(await overAttemptLimit(db, from('198.51.100.8'), at + 100, 'sign-in')).toBe(false);
		expect(
			await overAttemptLimit(db, from('198.51.100.7'), at + THROTTLE_WINDOW_MS, 'sign-in')
		).toBe(false);
	});

	it('a per-user scope keeps the smaller default budget', async () => {
		expect(CLIENT_MAX_ATTEMPTS).toBeGreaterThan(THROTTLE_MAX_ATTEMPTS);
		for (let i = 0; i < THROTTLE_MAX_ATTEMPTS; i++)
			expect(await overUserAttemptLimit(db, 'user-budget', at + i, 'account-password')).toBe(false);
		expect(await overUserAttemptLimit(db, 'user-budget', at + 50, 'account-password')).toBe(true);
	});

	it('counts concurrent attempts exactly (no lost update)', async () => {
		const results = await Promise.all(
			Array.from({ length: 30 }, () => overUserAttemptLimit(db, 'user-x', at + 5, 'search', 10))
		);
		expect(results.filter((over) => !over)).toHaveLength(10);
	});

	it('stores no address, only a hash', async () => {
		const rows = await db.all<{ client_hash: string }>(sql`select client_hash from auth_attempts`);
		for (const row of rows) expect(row.client_hash).toMatch(/^[0-9a-f]{64}$/);
	});
});
