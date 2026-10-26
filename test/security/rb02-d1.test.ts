import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import {
	createPage,
	deletePage,
	getBreadcrumbs,
	getChildren,
	movePage,
	restoreRevision,
	savePage
} from '#lib/server/kb/repo';
import { KB_LIMITS } from '#lib/server/kb/validation';
import { searchAll, SEARCH_MINUTE_MAX, SEARCH_THROTTLE_MAX } from '#lib/server/search/repo';
import { THROTTLE_WINDOW_MS } from '#lib/server/auth/throttle';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { insertProject, insertTask, pageRow, revisionsOf } from '../helpers/seed-kb';
import { insertUser } from '../helpers/users';

/**
 * RB-02 red-team probes against a fresh local D1 with the real migrations (FTS5 triggers included). See
 * docs/features/rb-02-knowledge-base/SECURITY_REPORT.md. Tests named PROOF document a finding; M1 and L1 are fixed
 * (cycle 2) and their PROOF tests now assert the fixed behaviour.
 */

const kbEdit = await import('../../src/routes/(app)/kb/[id]/edit/+page.server');
const kbMove = await import('../../src/routes/(app)/kb/[id]/move/+page.server');
const kbDelete = await import('../../src/routes/(app)/kb/[id]/delete/+page.server');
const kbNew = await import('../../src/routes/(app)/kb/new/+page.server');
const kbRevision = await import('../../src/routes/(app)/kb/[id]/history/[revision]/+page.server');
const kbHistory = await import('../../src/routes/(app)/kb/[id]/history/+page.server');
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

let clock = 1_800_000_000_000;
const tick = () => (clock += 1000);

async function newPage(
	title: string,
	by: SessionUser = member,
	parentId: string | null = null,
	projectId: string | null = null,
	body = 'Body'
) {
	const r = await createPage(db, by, { title, body, parentId, projectId }, tick());
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
	init: {
		user?: SessionUser;
		params?: Record<string, string>;
		form?: Record<string, string>;
		headers?: Record<string, string>;
	} = {}
) =>
	fakeEvent({
		url: `http://localhost${path}`,
		db,
		user: init.user ?? member,
		params: init.params,
		form: init.form,
		headers: init.headers
	}).event;

async function depthOf(id: string): Promise<number> {
	let d = 0;
	let cur: string | null = id;
	while (cur && d < 100) {
		d += 1;
		cur = (await pageRow(db, cur))?.parentId ?? null;
	}
	return d;
}

describe('authorization on delete', () => {
	it('a member cannot delete another member’s page directly (403)', async () => {
		const theirs = await newPage('Theirs', other);
		const e = await call(
			kbDelete.actions.delete,
			ev(`/kb/${theirs}/delete`, { params: { id: theirs }, form: { confirm: 'yes' } })
		);
		expect(status(e)).toBe(403);
		expect((await pageRow(db, theirs))?.deletedAt).toBeNull();
	});

	it('PROOF M1 (fixed): moving another member’s page under your own page does not let you delete it', async () => {
		const theirs = await newPage('Their runbook', other);
		const theirChild = await newPage('Their child', other, theirs);
		const mine = await newPage('Scratch', member);
		// Step 1: any active user may move any page (owner decision 1) — the move form, as the attacker.
		const moved = await call(
			kbMove.actions.move,
			ev(`/kb/${theirs}/move`, {
				params: { id: theirs },
				form: { scope: 'team', parentId: mine, placement: 'last' }
			})
		);
		expect(status(moved)).toBe(303);
		// Step 2: the attacker deletes their own page: refused (403), the subtree holds someone else's pages.
		const deleted = await call(
			kbDelete.actions.delete,
			ev(`/kb/${mine}/delete`, { params: { id: mine }, form: { confirm: 'yes' } })
		);
		expect(status(deleted)).toBe(403);
		expect(isHttpError(deleted) && deleted.body.message).toMatch(/other people created/);
		expect((await pageRow(db, mine))?.deletedAt).toBeNull();
		expect((await pageRow(db, theirs))?.deletedAt).toBeNull();
		expect((await pageRow(db, theirChild))?.deletedAt).toBeNull();
		// The confirmation page says why, and an admin may still delete the whole subtree.
		const form = (await call(
			kbDelete.load,
			ev(`/kb/${mine}/delete`, { params: { id: mine } })
		)) as {
			canDelete: boolean;
			forbidden: string | null;
		};
		expect(form.canDelete).toBe(false);
		expect(form.forbidden).toMatch(/other people created/);
		const byAdmin = await call(
			kbDelete.actions.delete,
			ev(`/kb/${mine}/delete`, { user: admin, params: { id: mine }, form: { confirm: 'yes' } })
		);
		expect(status(byAdmin)).toBe(303);
		expect((await pageRow(db, theirChild))?.deletedAt).not.toBeNull();
	});
});

describe('tree integrity under forged and concurrent moves', () => {
	it('forged moves: under self, under a descendant, under a deleted page, cross-scope parent — all refused, no row changes', async () => {
		const project = await insertProject(db, member.id, { key: 'OPS' });
		const [a, b, c] = await chain(3);
		const dead = await newPage('Dead');
		await deletePage(db, member, dead, tick());
		const inProject = await newPage('In project', member, null, project.id);
		await newPage('Top-level sibling');
		const before = await pageRow(db, a!);
		for (const form of [
			{ scope: 'team', parentId: a!, placement: 'last' },
			{ scope: 'team', parentId: c!, placement: 'last' },
			{ scope: 'team', parentId: dead, placement: 'last' },
			{ scope: 'team', parentId: inProject, placement: 'last' },
			{ scope: 'OPS', parentId: b!, placement: 'last' },
			{ scope: 'NOPE', parentId: '', placement: 'last' },
			{ scope: 'team', parentId: '', placement: `after:${c}` }
		]) {
			const r = await call(kbMove.actions.move, ev(`/kb/${a}/move`, { params: { id: a! }, form }));
			expect(status(r), JSON.stringify(form)).toBe(400);
		}
		expect(await pageRow(db, a!)).toEqual(before);
	});

	it('concurrent opposite moves never create a cycle', async () => {
		for (let round = 0; round < 10; round++) {
			const x = await newPage(`x${round}`);
			const y = await newPage(`y${round}`);
			await Promise.all([
				movePage(
					db,
					member,
					x,
					{ parentId: y, projectId: null, placement: { kind: 'last' } },
					tick()
				),
				movePage(
					db,
					other,
					y,
					{ parentId: x, projectId: null, placement: { kind: 'last' } },
					tick()
				)
			]);
			const px = (await pageRow(db, x))?.parentId;
			const py = (await pageRow(db, y))?.parentId;
			expect(px === y && py === x).toBe(false);
		}
	});

	it('PROOF L1 (fixed): two concurrent valid moves cannot stack past the depth limit (the UPDATE checks depth)', async () => {
		const t = await chain(4); // t[3] at depth 4
		const r = await chain(4); // height 4
		const s = await chain(4); // height 4
		const results = await Promise.all([
			movePage(
				db,
				member,
				s[0]!,
				{ parentId: r[3]!, projectId: null, placement: { kind: 'last' } },
				tick()
			),
			movePage(
				db,
				other,
				r[0]!,
				{ parentId: t[3]!, projectId: null, placement: { kind: 'last' } },
				tick()
			)
		]);
		const depth = await depthOf(s[3]!);
		console.info(
			`concurrent moves: ${results.map((x) => x.kind).join(',')}; deepest page at depth ${depth}`
		);
		expect(results.filter((x) => x.kind === 'moved')).toHaveLength(1);
		expect(depth).toBeLessThanOrEqual(KB_LIMITS.maxDepth);
		// Sequentially the second move is refused.
		const u = await chain(5);
		const v = await chain(4);
		expect(
			(
				await movePage(
					db,
					member,
					v[0]!,
					{ parentId: u[4]!, projectId: null, placement: { kind: 'last' } },
					tick()
				)
			).kind
		).toBe('invalid');
	});

	it('creating under a page of another space via a forged form is refused', async () => {
		const project = await insertProject(db, member.id, { key: 'OPS' });
		const teamPage = await newPage('Team');
		const r = await call(
			kbNew.actions.create,
			ev('/kb/new', { form: { title: 'x', body: '', parentId: teamPage, project: 'OPS' } })
		);
		expect(status(r)).toBe(400);
		const { results } = await db.$client
			.prepare('SELECT count(*) AS n FROM pages WHERE project_id = ?1')
			.bind(project.id)
			.all<{ n: number }>();
		expect(results[0]?.n).toBe(0);
	});
});

describe('revision IDOR and races', () => {
	it('a revision number of another page is a 404 on view and restore; nothing is written', async () => {
		const a = await newPage('A');
		const b = await newPage('B');
		await savePage(db, member, b, { title: 'B', body: 'secret v2' }, 1, tick());
		await savePage(db, member, b, { title: 'B', body: 'secret v3' }, 2, tick());
		const view = await call(
			kbRevision.load,
			ev(`/kb/${a}/history/3`, { params: { id: a, revision: '3' } })
		);
		expect(status(view)).toBe(404);
		const restore = await call(
			kbHistory.actions.restore,
			ev(`/kb/${a}/history`, { params: { id: a }, form: { revision: '3', expectedRevision: '1' } })
		);
		expect(status(restore)).toBe(404);
		expect(await revisionsOf(db, a)).toHaveLength(1);
		expect(await restoreRevision(db, member, a, 2, 1, tick())).toEqual({ kind: 'not-found' });
	});

	it('mixed concurrent saves and restores keep revisions contiguous and lose no confirmed write', async () => {
		const id = await newPage('Race');
		await savePage(db, member, id, { title: 'Race', body: 'v2' }, 1, tick());
		const ops = Array.from({ length: 12 }, (_, i) =>
			i % 3 === 0
				? restoreRevision(db, other, id, 1, 2, clock + i)
				: savePage(db, i % 2 ? member : other, id, { title: 'Race', body: `w${i}` }, 2, clock + i)
		);
		const results = await Promise.all(ops);
		expect(results.filter((r) => r.kind === 'saved')).toHaveLength(1);
		const revs = await revisionsOf(db, id);
		expect(revs.map((r) => r.revision)).toEqual([1, 2, 3]);
		expect((await pageRow(db, id))?.body).toBe(revs[2]?.body);
	});
});

describe('soft-deleted content never leaks', () => {
	it('search, breadcrumbs, children, history and direct URLs hide deleted pages and deleted projects', async () => {
		const project = await insertProject(db, member.id, { key: 'GONE' });
		const parent = await newPage('Parent kumquat');
		const child = await newPage('Child kumquat', member, parent);
		const kept = await newPage('Kept kumquat');
		const inGone = await newPage('Project kumquat', member, null, project.id);
		await insertTask(db, project, member.id, { number: 1, title: 'Task kumquat' });
		await savePage(
			db,
			member,
			child,
			{ title: 'Child kumquat', body: 'old secret zebrafish' },
			1,
			tick()
		);
		await deletePage(db, member, parent, tick());
		await db.$client
			.prepare('UPDATE projects SET deleted_at = ?1 WHERE id = ?2')
			.bind(tick(), project.id)
			.run();

		const all = await searchAll(db, 'kumquat', { type: 'all' });
		expect(all.pages.map((p) => p.id)).toEqual([kept]);
		expect(all.tasks).toEqual([]);
		expect((await searchAll(db, 'GONE-1', { type: 'all' })).exact).toBeNull();
		expect((await searchAll(db, 'zebrafish', { type: 'pages' })).pages).toEqual([]);
		expect(await getBreadcrumbs(db, child)).toEqual([]);
		expect(await getChildren(db, parent)).toEqual([]);
		for (const id of [parent, child, inGone]) {
			for (const fn of [kbEdit.load, kbHistory.load, kbMove.load, kbDelete.load])
				expect(status(await call(fn, ev(`/kb/${id}`, { params: { id } })))).toBe(404);
			expect(
				status(
					await call(kbRevision.load, ev(`/kb/${id}/history/1`, { params: { id, revision: '1' } }))
				)
			).toBe(404);
		}
		// `new?parent=<deleted>` does not reveal or inherit the deleted page.
		const data = (await call(kbNew.load, ev(`/kb/new?parent=${child}`))) as { parentId: string };
		expect(data.parentId).toBe('');
	});
});

describe('search hardening against real FTS5', () => {
	it('hostile MATCH input never throws and never widens the result set', async () => {
		await newPage('Alpha secret', member, null, null, 'title body near caret');
		await newPage('Beta', member, null, null, 'nothing');
		for (const q of [
			'title:beta',
			'body:nothing',
			'{title}:x',
			'NEAR(alpha beta)',
			'^alpha',
			'"alpha',
			'alpha"',
			'alpha OR beta',
			'NOT alpha',
			'a* b* c* d* e* f* g* h* i* j*',
			"' OR 1=1 --",
			'\u0000',
			'x'.repeat(5000),
			'(((((((((((((((',
			'* * * *'
		]) {
			const r = await searchAll(db, q, { type: 'all' });
			// `alpha OR beta` is AND of three prefix terms, so nothing matches "or" — never both rows.
			expect(r.pages.length, q).toBeLessThanOrEqual(1);
		}
	});

	it('the expensive shape (8 one-letter prefixes over a large index) stays bounded', async () => {
		const words = 'abcdefghijklmnopqrstuvwxyz'.split('');
		let seed = 7;
		const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
		const stmts = [];
		for (let i = 0; i < 300; i++) {
			const body = Array.from({ length: 2000 }, () =>
				Array.from({ length: 2 + Math.floor(rnd() * 6) }, () => words[Math.floor(rnd() * 26)]).join(
					''
				)
			).join(' ');
			stmts.push(
				db.$client
					.prepare(
						`INSERT INTO pages (id, title, body, position, revision, created_by, updated_by, created_at, updated_at)
						 VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, ?6, ?6)`
					)
					.bind(crypto.randomUUID(), `p${i}`, body, i, member.id, tick())
			);
		}
		await db.$client.batch(stmts);
		const t0 = performance.now();
		const r = await searchAll(db, 'a b c d e f g h', { type: 'pages' });
		const ms = performance.now() - t0;
		expect(r.pages.length).toBeLessThanOrEqual(50);
		console.info(`8 one-letter prefixes over 300 pages × 2000 words: ${ms.toFixed(0)} ms`);
		expect(ms).toBeLessThan(5000);
	});

	it('throttle: the 31st search in a minute and the 301st in a window are 429 whatever the type; per user', async () => {
		await newPage('Throttle me');
		const load = (q: string, type = 'all', user = member) =>
			call(searchRoute.load, ev(`/search?q=${encodeURIComponent(q)}&type=${type}`, { user }));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			// L2 (fixed): 30 a minute. Ten minutes of full minutes fill the 10-minute window's 300 exactly.
			const start = Math.ceil(Date.now() / THROTTLE_WINDOW_MS) * THROTTLE_WINDOW_MS;
			for (let minute = 0; minute < 10; minute++) {
				vi.setSystemTime(start + minute * 60_000 + 1000);
				for (let i = 0; i < SEARCH_MINUTE_MAX; i++) {
					const r = await load(`throttle${minute}x${i}`, ['all', 'pages', 'tasks'][i % 3]);
					expect(status(r)).toBe(200);
				}
				if (minute === 0)
					for (const type of ['all', 'pages', 'tasks', 'bogus'])
						expect(status(await load('throttle', type))).toBe(429);
			}
			expect(SEARCH_MINUTE_MAX * 10).toBe(SEARCH_THROTTLE_MAX);
			// The 10-minute budget is spent too: a new minute in the same window is still refused.
			vi.setSystemTime(start + 9 * 60_000 + 59_000);
			expect(status(await load('throttle'))).toBe(429);
			expect(status(await load('throttle', 'all', other))).toBe(200);
		} finally {
			vi.useRealTimers();
		}
	}, 120_000); // 300+ sequential D1 searches: slow when the machine is busy.
});

describe('body limits and form handling', () => {
	it('an edit body over the byte cap is refused before parsing; a lying Content-Length does not help', async () => {
		const id = await newPage('Size');
		const huge = 'x'.repeat(KB_LIMITS.formMaxBytes + 10);
		const form = new FormData();
		form.set('title', 'Size');
		form.set('body', huge);
		form.set('expectedRevision', '1');
		const req = new Request(`http://localhost/kb/${id}/edit`, { method: 'POST', body: form });
		const base = fakeEvent({
			url: `http://localhost/kb/${id}/edit`,
			db,
			user: member,
			params: { id }
		}).event;
		const event = { ...base, request: req } as typeof base;
		expect(status(await call(kbEdit.actions.save, event))).toBe(400);

		const body = new URLSearchParams({
			title: 'Size',
			body: huge,
			expectedRevision: '1'
		}).toString();
		const lying = new Request(`http://localhost/kb/${id}/edit`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '10' },
			body
		});
		expect(status(await call(kbEdit.actions.save, { ...base, request: lying }))).toBe(400);
		expect((await pageRow(db, id))?.revision).toBe(1);
	});

	it('a body of 200,001 characters is a field error, nothing saved', async () => {
		const id = await newPage('Chars');
		const r = await call(
			kbEdit.actions.save,
			ev(`/kb/${id}/edit`, {
				params: { id },
				form: { title: 'Chars', body: 'y'.repeat(200_001), expectedRevision: '1' }
			})
		);
		expect(status(r)).toBe(400);
		expect((await pageRow(db, id))?.revision).toBe(1);
	});

	it('post-action redirects stay on the site (ids and keys come from the database)', async () => {
		const project = await insertProject(db, member.id, { key: 'OPS' });
		const id = await newPage('Redir', member, null, project.id);
		const r = await call(
			kbDelete.actions.delete,
			ev(`/kb/${id}/delete`, {
				params: { id },
				form: { confirm: 'yes', redirectTo: 'https://evil.example' }
			})
		);
		expect(isRedirect(r) && r.location).toBe('/kb/projects/OPS?notice=deleted');
		const a = await newPage('A2');
		const saved = await call(
			kbEdit.actions.save,
			ev(`/kb/${a}/edit?redirectTo=//evil.example`, {
				params: { id: a },
				form: { title: 'A2', body: 'new', expectedRevision: '1', next: '//evil.example' }
			})
		);
		expect(isRedirect(saved) && saved.location).toBe(`/kb/${a}?notice=saved`);
	});
});

describe('admin rules', () => {
	it('an admin may delete any page; a member who created the page may; a disabled role cannot reach locals', async () => {
		const theirs = await newPage('Theirs', other);
		expect((await deletePage(db, admin, theirs, tick())).kind).toBe('deleted');
		const own = await newPage('Own', member);
		expect((await deletePage(db, member, own, tick())).kind).toBe('deleted');
		const forged = { ...member, role: 'member' as const };
		const third = await newPage('Third', admin);
		expect((await deletePage(db, forged, third, tick())).kind).toBe('forbidden');
	});
});
