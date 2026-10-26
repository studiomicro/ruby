import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import {
	overAttemptLimit,
	overUserAttemptLimit,
	overUserMinuteLimit,
	retryAfterSeconds,
	THROTTLE_MINUTE_MS,
	THROTTLE_WINDOW_MS
} from '#lib/server/auth/throttle';
import { getDb, type Db } from '#lib/server/db';
import { createPage, deletePage, movePage, savePage } from '#lib/server/kb/repo';
import { checkBody, KB_LIMITS } from '#lib/server/kb/validation';
import { buildMatchQuery } from '#lib/server/search/query';
import { SEARCH_MINUTE_MAX } from '#lib/server/search/repo';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { pageRow } from '../helpers/seed-kb';
import { insertUser } from '../helpers/users';

/**
 * RB-02 red-team re-check after cycle 2 (M1, L1, L2, L3, QA L2 and the shared throttle change). See
 * docs/features/rb-02-knowledge-base/SECURITY_REPORT.md › Re-check after cycle 2.
 */

const kbDelete = await import('../../src/routes/(app)/kb/[id]/delete/+page.server');
const kbView = await import('../../src/routes/(app)/kb/[id]/+page.server');
const searchRoute = await import('../../src/routes/(app)/search/+page.server');

let db: Db;
let dispose: () => Promise<void>;
let admin: SessionUser;
let member: SessionUser;
let other: SessionUser;

beforeAll(async () => {
	const opened = await openLocalD1();
	db = getDb(opened.db);
	dispose = opened.dispose;
});
afterAll(() => dispose());
beforeEach(async () => {
	for (const table of [
		'page_revisions',
		'pages',
		'tasks',
		'projects',
		'auth_attempts',
		'sessions',
		'user_passwords',
		'users'
	])
		await db.run(sql.raw(`delete from ${table}`));
	admin = await insertUser(db, { role: 'admin' });
	member = await insertUser(db, { role: 'member' });
	other = await insertUser(db, { role: 'member' });
});

let clock = 1_900_000_000_000;
const tick = () => (clock += 1000);

async function newPage(title: string, by: SessionUser = member, parentId: string | null = null) {
	const r = await createPage(db, by, { title, body: 'Body', parentId, projectId: null }, tick());
	if (!r.ok) throw new Error(r.error);
	return r.id;
}
async function chain(n: number, by: SessionUser = member, top: string | null = null) {
	const ids: string[] = [];
	let parent = top;
	for (let i = 0; i < n; i++) {
		parent = await newPage(`c${i}`, by, parent);
		ids.push(parent);
	}
	return ids;
}
async function depthOf(id: string): Promise<number> {
	let d = 0;
	let cur: string | null = id;
	while (cur && d < 100) {
		d += 1;
		cur = (await pageRow(db, cur))?.parentId ?? null;
	}
	return d;
}
type Fn = (event: never) => unknown;
async function call(fn: unknown, event: unknown): Promise<unknown> {
	try {
		return await (fn as Fn)(event as never);
	} catch (e) {
		return e;
	}
}
const status = (x: unknown) =>
	isHttpError(x) ? x.status : isRedirect(x) ? x.status : isActionFailure(x) ? x.status : 200;
const ev = (
	path: string,
	init: { user?: SessionUser; params?: Record<string, string>; form?: Record<string, string> } = {}
) =>
	fakeEvent({
		url: `http://localhost${path}`,
		db,
		user: init.user ?? member,
		params: init.params,
		form: init.form
	}).event;

describe('M1 re-check: subtree delete', () => {
	it('move-into-subtree racing delete never sweeps another member’s page away (30 rounds)', async () => {
		for (let round = 0; round < 30; round++) {
			const theirs = await newPage(`T${round}`, other);
			const theirChild = await newPage(`TC${round}`, other, theirs);
			const mine = await newPage(`M${round}`, member);
			const [moved, deleted] = await Promise.all([
				movePage(
					db,
					member,
					theirs,
					{ parentId: mine, projectId: null, placement: { kind: 'last' } },
					tick()
				),
				deletePage(db, member, mine, tick())
			]);
			expect((await pageRow(db, theirs))?.deletedAt).toBeNull();
			expect((await pageRow(db, theirChild))?.deletedAt).toBeNull();
			// Either the move won (delete refused) or the delete won (move refused): never both applied.
			if (deleted.kind === 'deleted') expect(moved.kind).not.toBe('moved');
			if (moved.kind === 'moved') expect(deleted.kind).toBe('forbidden');
		}
	});

	it('the confirmation said yes, then a page by someone else is moved in: the action is refused (the UPDATE decides)', async () => {
		const mine = await newPage('Mine');
		const form = (await call(
			kbDelete.load,
			ev(`/kb/${mine}/delete`, { params: { id: mine } })
		)) as {
			canDelete: boolean;
		};
		expect(form.canDelete).toBe(true);
		const theirs = await newPage('Theirs', other);
		expect(
			(
				await movePage(
					db,
					other,
					theirs,
					{ parentId: mine, projectId: null, placement: { kind: 'last' } },
					tick()
				)
			).kind
		).toBe('moved');
		const r = await call(
			kbDelete.actions.delete,
			ev(`/kb/${mine}/delete`, { params: { id: mine }, form: { confirm: 'yes' } })
		);
		expect(status(r)).toBe(403);
		expect((await pageRow(db, theirs))?.deletedAt).toBeNull();
		expect((await pageRow(db, mine))?.deletedAt).toBeNull();
	});

	it('a page by a since-disabled user still blocks a member; an admin may delete; deeper descendants count too', async () => {
		const mine = await newPage('Mine');
		const mid = await newPage('Mid (mine)', member, mine);
		const gone = await newPage('By a leaver', other, mid);
		await db.run(sql`update users set status = 'disabled' where id = ${other.id}`);
		expect((await deletePage(db, member, mine, tick())).kind).toBe('forbidden');
		expect((await deletePage(db, member, mid, tick())).kind).toBe('forbidden');
		expect((await pageRow(db, gone))?.deletedAt).toBeNull();
		const r = await deletePage(db, admin, mine, tick());
		expect(r.kind === 'deleted' && r.count).toBe(3);
		const row = await db.get<{ updated_by: string }>(
			sql`select updated_by from pages where id = ${gone}`
		);
		expect(row?.updated_by).toBe(admin.id); // L3
	});

	it('only live pages count: once an admin removed the foreign subpage, the creator may delete; edits do not change ownership', async () => {
		const mine = await newPage('Mine');
		const theirs = await newPage('Theirs', other, mine);
		// Another member editing my page does not make it theirs, and my editing theirs does not make it mine.
		const page = await pageRow(db, mine);
		await savePage(
			db,
			other,
			mine,
			{ title: 'Mine', body: 'edited by other' },
			page!.revision,
			tick()
		);
		const theirRow = await pageRow(db, theirs);
		await savePage(
			db,
			member,
			theirs,
			{ title: 'Theirs', body: 'edited by me' },
			theirRow!.revision,
			tick()
		);
		expect((await deletePage(db, member, mine, tick())).kind).toBe('forbidden');
		expect((await deletePage(db, admin, theirs, tick())).kind).toBe('deleted');
		const view = (await call(kbView.load, ev(`/kb/${mine}`, { params: { id: mine } }))) as {
			canDelete: boolean;
		};
		expect(view.canDelete).toBe(true);
		const r = await deletePage(db, member, mine, tick());
		expect(r.kind === 'deleted' && r.count).toBe(1);
		const row = await db.get<{ updated_by: string }>(
			sql`select updated_by from pages where id = ${mine}`
		);
		expect(row?.updated_by).toBe(member.id); // L3
	});

	it('a member cannot delete someone else’s root even when every subpage is theirs', async () => {
		const theirs = await newPage('Theirs', other);
		const myChild = await newPage('Mine under theirs', member, theirs);
		expect(await deletePage(db, member, theirs, tick())).toEqual({
			kind: 'forbidden',
			reason: 'not-creator'
		});
		expect((await pageRow(db, myChild))?.deletedAt).toBeNull();
		// Deleting my own subpage there is fine.
		expect((await deletePage(db, member, myChild, tick())).kind).toBe('deleted');
	});
});

describe('L1 re-check: depth under concurrent moves', () => {
	it('three-way concurrent moves of chains never exceed the depth limit (15 rounds)', async () => {
		let worst = 0;
		for (let round = 0; round < 15; round++) {
			const a = await chain(3);
			const b = await chain(3, other);
			const c = await chain(3);
			const d = await chain(3, other);
			await Promise.all([
				movePage(
					db,
					member,
					b[0]!,
					{ parentId: a[2]!, projectId: null, placement: { kind: 'last' } },
					tick()
				),
				movePage(
					db,
					other,
					c[0]!,
					{ parentId: b[2]!, projectId: null, placement: { kind: 'last' } },
					tick()
				),
				movePage(
					db,
					admin,
					d[0]!,
					{ parentId: c[2]!, projectId: null, placement: { kind: 'last' } },
					tick()
				)
			]);
			worst = Math.max(worst, await depthOf(d[2]!), await depthOf(c[2]!), await depthOf(b[2]!));
		}
		expect(worst).toBeLessThanOrEqual(KB_LIMITS.maxDepth);
	});

	it('a move to exactly the limit is allowed, one more level is refused', async () => {
		const top = await chain(4);
		const sub = await chain(4);
		expect(
			(
				await movePage(
					db,
					member,
					sub[0]!,
					{ parentId: top[3]!, projectId: null, placement: { kind: 'last' } },
					tick()
				)
			).kind
		).toBe('moved');
		expect(await depthOf(sub[3]!)).toBe(8);
		const one = await newPage('one');
		const r = await movePage(
			db,
			member,
			one,
			{ parentId: sub[3]!, projectId: null, placement: { kind: 'last' } },
			tick()
		);
		expect(r.kind).toBe('invalid');
	});
});

describe('L2 re-check: search cost', () => {
	it('one-character tokens are exact, two or more keep the prefix, whatever the script', () => {
		expect(buildMatchQuery('a b c d e f g h')).toBe('"a" "b" "c" "d" "e" "f" "g" "h"');
		expect(buildMatchQuery('ａ')).toBe('"a"'); // full-width letter, NFKC
		expect(buildMatchQuery('日')).toBe('"日"');
		expect(buildMatchQuery('𝐀')).toBe('"a"'); // astral bold A, NFKC, one code point
		expect(buildMatchQuery('ab')).toBe('"ab"*');
		// A combining mark is not a letter: it splits rather than lengthening a one-letter token.
		expect(buildMatchQuery('á')).toBe('"á"');
		expect(buildMatchQuery('ë́')).toMatch(/^"[^"]+"\*?$/);
	});

	it('the 31st search in a minute is 429 with a Retry-After inside that minute; the per-minute key fails closed', async () => {
		await newPage('Throttle me');
		vi.useFakeTimers({ toFake: ['Date'] });
		const start = Math.ceil(Date.now() / THROTTLE_WINDOW_MS) * THROTTLE_WINDOW_MS;
		try {
			vi.setSystemTime(start + 3 * 60_000 + 15_000);
			for (let i = 0; i < SEARCH_MINUTE_MAX; i++) {
				const e = ev(`/search?q=throttle${i}`);
				expect(status(await call(searchRoute.load, e))).toBe(200);
			}
			const headers: Record<string, string> = {};
			const e = ev('/search?q=throttle');
			(e as { setHeaders: (h: Record<string, string>) => void }).setHeaders = (h) =>
				Object.assign(headers, h);
			expect(status(await call(searchRoute.load, e))).toBe(429);
			expect(headers['retry-after']).toBe('45');
			expect(retryAfterSeconds(start + 1, THROTTLE_WINDOW_MS)).toBe(600);
			expect(retryAfterSeconds(start + 1, THROTTLE_MINUTE_MS)).toBe(60);
			// The next minute opens again.
			vi.setSystemTime(start + 4 * 60_000);
			expect(status(await call(searchRoute.load, ev('/search?q=throttle')))).toBe(200);
		} finally {
			vi.useRealTimers();
		}
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const broken = getDb({
			prepare: () => {
				throw new Error('D1_ERROR: unavailable');
			},
			batch: () => Promise.reject(new Error('D1_ERROR: unavailable'))
		} as unknown as D1Database);
		expect(await overUserMinuteLimit(broken, member.id, start, 'search', 30)).toBe(true);
		log.mockRestore();
	});
});

describe('shared throttle: RB-00 budgets are not weakened by the minute window or the new cleanup', () => {
	const from = (ip: string) =>
		new Request('http://localhost/login', { headers: { 'cf-connecting-ip': ip } });

	it('a minute-window first attempt (which runs the cleanup) never resets a running 10-minute sign-in, setup, invite or password window', async () => {
		const w = 2_000_000_000_000 - (2_000_000_000_000 % THROTTLE_WINDOW_MS);
		for (let i = 0; i < 100; i++) {
			await overAttemptLimit(db, from('198.51.100.7'), w + i, 'sign-in');
			await overAttemptLimit(db, from('198.51.100.7'), w + i, 'setup');
			await overAttemptLimit(db, from('198.51.100.7'), w + i, 'invite-accept');
		}
		for (let i = 0; i < 20; i++)
			await overUserAttemptLimit(db, member.id, w + i, 'account-password');
		// Minute windows open at every minute of the 10-minute window (each runs the cleanup), up to its last ms.
		for (let m = 1; m <= 10; m++) {
			const at = Math.min(w + m * THROTTLE_MINUTE_MS, w + THROTTLE_WINDOW_MS - 1);
			const u = await insertUser(db);
			expect(await overUserMinuteLimit(db, u.id, at, 'search', 30)).toBe(false);
			expect(await overAttemptLimit(db, from('198.51.100.7'), at, 'sign-in')).toBe(true);
			expect(await overAttemptLimit(db, from('198.51.100.7'), at, 'setup')).toBe(true);
			expect(await overAttemptLimit(db, from('198.51.100.7'), at, 'invite-accept')).toBe(true);
			expect(await overUserAttemptLimit(db, member.id, at, 'account-password')).toBe(true);
		}
		// A request whose clock runs 90 s ahead (a skewed isolate) does not clear the running window either: the cleanup
		// only removes a window once some clock has passed its end, the same condition as before cycle 2.
		const ahead = await insertUser(db);
		await overUserMinuteLimit(db, ahead.id, w + 500_000 + 90_000, 'search', 30);
		expect(await overAttemptLimit(db, from('198.51.100.7'), w + 500_000, 'sign-in')).toBe(true);
		// The next 10-minute window starts fresh, as before.
		expect(
			await overAttemptLimit(db, from('198.51.100.7'), w + THROTTLE_WINDOW_MS, 'sign-in')
		).toBe(false);
	});

	it('table growth stays bounded: one row per key, old rows go on the next first attempt', async () => {
		const w = 2_100_000_000_000 - (2_100_000_000_000 % THROTTLE_WINDOW_MS);
		const u = await insertUser(db);
		for (let m = 0; m < 30; m++) {
			await overUserMinuteLimit(db, u.id, w + m * THROTTLE_MINUTE_MS, 'search', 30);
			await overUserAttemptLimit(db, u.id, w + m * THROTTLE_MINUTE_MS, 'search', 300);
		}
		const rows = await db.all<{ n: number }>(sql`select count(*) as n from auth_attempts`);
		expect(rows[0]?.n).toBe(2);
		for (let i = 0; i < 50; i++)
			await overUserMinuteLimit(db, `u-${i}`, w + 30 * THROTTLE_MINUTE_MS, 'search', 30);
		await overUserMinuteLimit(
			db,
			'late',
			w + 30 * THROTTLE_MINUTE_MS + THROTTLE_WINDOW_MS + 1,
			'search',
			30
		);
		const after = await db.all<{ n: number }>(sql`select count(*) as n from auth_attempts`);
		expect(after[0]?.n).toBe(1);
	});
});

describe('QA L2 re-check: body limit in code points', () => {
	it('200,000 astral characters pass and fit the 1 MiB form cap as UTF-8; lone surrogates and CRLF cannot dodge the count', () => {
		const max = '😀'.repeat(KB_LIMITS.bodyMax);
		expect(checkBody(max).error).toBeUndefined();
		expect(new TextEncoder().encode(max).length + 4 * KB_LIMITS.titleMax).toBeLessThan(
			KB_LIMITS.formMaxBytes - 4096
		);
		expect(checkBody('\ud800'.repeat(KB_LIMITS.bodyMax + 1)).error).toBeTruthy();
		expect(checkBody('😀'.repeat(KB_LIMITS.bodyMax - 1) + '\ud800\ud800').error).toBeTruthy();
		expect(checkBody('\r\n'.repeat(KB_LIMITS.bodyMax)).error).toBeUndefined(); // normalised to 200,000 '\n'
		expect(checkBody('\r\n'.repeat(KB_LIMITS.bodyMax) + 'x').error).toBeTruthy();
		const t0 = performance.now();
		checkBody('😀'.repeat(KB_LIMITS.bodyMax * 2));
		expect(performance.now() - t0).toBeLessThan(500);
	});
});

describe('ownership after edits', () => {
	it('savePage by another member really lands and never changes created_by', async () => {
		const mine = await newPage('Mine');
		const page = await pageRow(db, mine);
		const r = await savePage(
			db,
			other,
			mine,
			{ title: 'Mine', body: 'edited' },
			page!.revision,
			tick()
		);
		expect(r.kind).toBe('saved');
		const row = await db.get<{ created_by: string; updated_by: string }>(
			sql`select created_by, updated_by from pages where id = ${mine}`
		);
		expect(row).toEqual({ created_by: member.id, updated_by: other.id });
	});
});
