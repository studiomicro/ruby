import { isHttpError } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { render } from 'svelte/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { THROTTLE_WINDOW_MS } from '#lib/server/auth/throttle';
import { getDb, type Db } from '#lib/server/db';
import { createPage, deletePage, restoreRevision, savePage } from '#lib/server/kb/repo';
import {
	SEARCH_MAX,
	SEARCH_MINUTE_MAX,
	SEARCH_THROTTLE_MAX,
	searchAll
} from '#lib/server/search/repo';
import { sha256Hex } from '#lib/server/util';
import Highlighted from '../../src/routes/(app)/search/Highlighted.svelte';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { insertProject, insertTask } from '../helpers/seed-kb';
import { insertUser } from '../helpers/users';

/** Search against real FTS5: consistency with the live rows, ranking, caps, hostile input, throttle, safe snippets. */

const route = await import('../../src/routes/(app)/search/+page.server');

let db: Db;
let dispose: () => Promise<void>;
let user: SessionUser;

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
		'user_passwords',
		'users'
	])
		await db.run(sql.raw(`delete from ${table}`));
	user = await insertUser(db, { name: 'Sam Searcher' });
});

let clock = 1_800_000_000_000;
const tick = () => (clock += 1000);
const text = (segments: { text: string }[]) => segments.map((s) => s.text).join('');

async function page(title: string, body = '', projectId: string | null = null) {
	const r = await createPage(db, user, { title, body, parentId: null, projectId }, tick());
	if (!r.ok) throw new Error(r.error);
	return r.id;
}

const pageTitles = async (q: string) =>
	(await searchAll(db, q, { type: 'pages' })).pages.map((p) => text(p.title));

describe('FTS consistency', () => {
	it('follows create, edit, delete and restore-as-new-revision', async () => {
		const id = await page('Runbook', 'restart the zeppelin service');
		expect(await pageTitles('zeppelin')).toEqual(['Runbook']);
		await savePage(
			db,
			user,
			id,
			{ title: 'Runbook', body: 'restart the blimp service' },
			1,
			tick()
		);
		expect(await pageTitles('zeppelin')).toEqual([]);
		expect(await pageTitles('blimp')).toEqual(['Runbook']);
		await restoreRevision(db, user, id, 1, 2, tick());
		expect(await pageTitles('zeppelin')).toEqual(['Runbook']);
		expect(await pageTitles('blimp')).toEqual([]);
		await deletePage(db, user, id, tick());
		expect(await pageTitles('zeppelin')).toEqual([]);
	});

	it('matches every word by prefix, ranks title hits first, folds accents', async () => {
		await page('Notes', 'the foo and the bar');
		await page('Foo bar guide', 'unrelated');
		await page('Only foo', 'nothing else');
		await page('Café opening hours', '');
		expect(await pageTitles('foo bar')).toEqual(['Foo bar guide', 'Notes']);
		expect(await pageTitles('fo ba')).toEqual(['Foo bar guide', 'Notes']);
		expect(await pageTitles('cafe')).toEqual(['Café opening hours']);
		expect(await pageTitles('CAFÉ')).toEqual(['Café opening hours']);
	});

	it('excludes deleted tasks and tasks of deleted projects; marks archived ones', async () => {
		const live = await insertProject(db, user.id, { key: 'OPS' });
		const archived = await insertProject(db, user.id, { key: 'OLD', status: 'archived' });
		const gone = await insertProject(db, user.id, { key: 'GONE', deletedAt: 1 });
		await insertTask(db, live, user.id, { number: 1, title: 'Rotate keys' });
		await insertTask(db, live, user.id, { number: 2, title: 'Rotate certs', deletedAt: 1 });
		await insertTask(db, archived, user.id, { number: 1, title: 'Rotate logs' });
		await insertTask(db, gone, user.id, { number: 1, title: 'Rotate nothing' });
		const { tasks } = await searchAll(db, 'rotate', { type: 'tasks' });
		expect(tasks.map((t) => [`${t.key}-${t.number}`, t.archived]).sort()).toEqual([
			['OLD-1', true],
			['OPS-1', false]
		]);
		const archivedPage = await page('Archived spec', '', archived.id);
		const hits = (await searchAll(db, 'archived spec', { type: 'pages' })).pages;
		expect(hits.map((h) => [h.id, h.projectKey, h.archived])).toEqual([
			[archivedPage, 'OLD', true]
		]);
	});

	it('caps results at 25 per type for all and 50 for one type', async () => {
		const project = await insertProject(db, user.id, { key: 'CAP' });
		await db.$client
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
				 INSERT INTO pages (id, title, body, position, revision, created_by, updated_by, created_at, updated_at)
				 SELECT lower(hex(randomblob(16))), 'Widget ' || i, '', i, 1, ?1, ?1, 1, 1 FROM n`
			)
			.bind(user.id)
			.run();
		for (let i = 1; i <= 60; i++)
			await insertTask(db, project, user.id, { number: i, title: `Widget task ${i}` });
		const all = await searchAll(db, 'widget', { type: 'all' });
		expect([all.pages.length, all.tasks.length, all.limit]).toEqual([25, 25, SEARCH_MAX.all]);
		const pages = await searchAll(db, 'widget', { type: 'pages' });
		expect([pages.pages.length, pages.tasks.length]).toEqual([50, 0]);
		const tasks = await searchAll(db, 'widget', { type: 'tasks' });
		expect([tasks.pages.length, tasks.tasks.length]).toEqual([0, 50]);
	});

	it('shows a task named by its identifier first, as the exact match', async () => {
		const project = await insertProject(db, user.id, { key: 'OPS' });
		await insertTask(db, project, user.id, { number: 12, title: 'Renew the certificate' });
		const result = await searchAll(db, 'ops-12', { type: 'all' });
		expect(result.exact && `${result.exact.key}-${result.exact.number}`).toBe('OPS-12');
		expect(result.tasks.some((t) => t.id === result.exact?.id)).toBe(false);
		expect((await searchAll(db, 'OPS-13', { type: 'all' })).exact).toBeNull();
	});
});

describe('hostile input', () => {
	const hostile = [
		'"',
		'""',
		'*',
		'AND OR NOT',
		'a:b',
		'title:x',
		'NEAR(a b)',
		'NEAR/2',
		'(',
		')',
		'-x',
		'^x',
		'+x',
		'{title}:x',
		"'; DROP TABLE pages; --",
		'x'.repeat(10_000),
		'ab '.repeat(5_000),
		'😀🔥',
		'!!!...???',
		'\u0000\u0001\u0002',
		`${'a'.repeat(60)}`,
		'"unbalanced quote',
		'ｆｕｌｌｗｉｄｔｈ'
	];

	it.each(hostile.map((q) => [q.slice(0, 30), q]))('%j never throws', async (_label, q) => {
		await page('Some page', 'with some body text');
		const result = await searchAll(db, q, { type: 'all' });
		expect(Array.isArray(result.pages)).toBe(true);
	});

	it('a 60-character term matches its page', async () => {
		const word = 'p'.repeat(60);
		await page('Long word', word);
		expect(await pageTitles(word)).toEqual(['Long word']);
	});
});

describe('the /search route', () => {
	const load = (q: string | null, extra = '') => {
		const url = `http://localhost/search${q === null ? '' : `?q=${encodeURIComponent(q)}${extra}`}`;
		const headers: Record<string, string> = {};
		const { event } = fakeEvent({ url, db, user });
		(event as { setHeaders: (h: Record<string, string>) => void }).setHeaders = (h) =>
			Object.assign(headers, h);
		return { run: () => route.load(event as never) as Promise<Record<string, unknown>>, headers };
	};
	const attempts = async () =>
		Number(
			(
				await db.$client.prepare('select coalesce(sum(count), 0) as n from auth_attempts').first<{
					n: number;
				}>()
			)?.n
		);

	it('signed out is refused', async () => {
		const { event } = fakeEvent({ url: 'http://localhost/search?q=x', db });
		const e = await Promise.resolve(route.load(event as never)).catch((x: unknown) => x);
		expect(isHttpError(e) && e.status).toBe(401);
	});

	it('empty and token-less queries show hints and are not counted', async () => {
		expect(await load(null).run()).toMatchObject({ state: 'initial', q: '', type: 'all' });
		expect(await load('  ').run()).toMatchObject({ state: 'initial' });
		expect(await load('"*()').run()).toMatchObject({ state: 'too-short', q: '"*()' });
		expect(await attempts()).toBe(0);
	});

	it('an invalid type falls back to all; a valid one is kept', async () => {
		await page('Typed', '');
		expect(await load('typed', '&type=users').run()).toMatchObject({
			type: 'all',
			state: 'results'
		});
		const tasksOnly = (await load('typed', '&type=tasks').run()) as {
			results: { pages: unknown[] };
		};
		expect(tasksOnly.results.pages).toEqual([]);
	});

	it('the 31st search within one minute answers 429 with a Retry-After under a minute', async () => {
		await page('Minute cap', '');
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			// Early in a fresh minute (and in a 10-minute window of its own), so the burst stays in one minute window.
			vi.setSystemTime(Math.ceil(Date.now() / THROTTLE_WINDOW_MS) * THROTTLE_WINDOW_MS + 1000);
			for (let i = 0; i < SEARCH_MINUTE_MAX; i++)
				expect((await load(`minute ${i}`).run()).state).toBe('results');
			const { run, headers } = load('minute over');
			const e = await run().catch((x: unknown) => x);
			expect(isHttpError(e) && e.status).toBe(429);
			const retry = Number(headers['retry-after']);
			expect(retry).toBeGreaterThan(0);
			expect(retry).toBeLessThanOrEqual(60);
			// The next minute has a fresh budget.
			vi.setSystemTime(Date.now() + 60_000);
			expect((await load('next minute').run()).state).toBe('results');
		} finally {
			vi.useRealTimers();
		}
	});

	it('over the throttle answers 429 with Retry-After and does not run the query', async () => {
		await page('Throttled', '');
		// The route reads the real clock: fill this user's current search window to the limit.
		const windowStart = Date.now() - (Date.now() % THROTTLE_WINDOW_MS);
		await db.$client
			.prepare('insert into auth_attempts (client_hash, window_start, count) values (?1, ?2, ?3)')
			.bind(await sha256Hex(`search:user:${user.id}`), windowStart, SEARCH_THROTTLE_MAX)
			.run();
		const { run, headers } = load('throttled');
		const e = await run().catch((x: unknown) => x);
		expect(isHttpError(e) && e.status).toBe(429);
		expect(isHttpError(e) && e.body.message).toBe('Too many searches, wait a moment.');
		expect(Number(headers['retry-after'])).toBeGreaterThan(0);
	});

	it('hostile queries through the route never fail', async () => {
		for (const q of ['NEAR(a b)', '"', 'a:b', 'x'.repeat(10_000)]) {
			const data = await load(q).run();
			expect(['results', 'too-short']).toContain(data.state);
		}
	});
});

describe('snippets render as text', () => {
	it('a body with <script>, <img onerror> and stray markers produces only <mark> elements', async () => {
		const project = await insertProject(db, user.id, { key: 'XSS' });
		const nasty =
			'<script>alert(1)</script> needle <img src=x onerror=alert(2)> \u0001fake\u0002 needle';
		// Through the page editor the markers are stripped; a task description is written raw here.
		await insertTask(db, project, user.id, {
			number: 1,
			title: '<b>needle</b>',
			description: nasty
		});
		await page('<svg onload=alert(3)> needle', nasty);
		const result = await searchAll(db, 'needle', { type: 'all' });
		const hits = [...result.pages, ...result.tasks];
		expect(hits).toHaveLength(2);
		for (const hit of hits)
			for (const segments of [hit.title, hit.snippet]) {
				const html = render(Highlighted, { props: { segments } }).body;
				const elements = [...html.matchAll(/<([a-z][a-z0-9-]*)/gi)].map((m) => m[1]);
				expect(new Set(elements)).toEqual(new Set(['mark']));
				expect(html.includes('\u0001') || html.includes('\u0002')).toBe(false);
				expect(html).toContain('&lt;');
			}
	});
});
