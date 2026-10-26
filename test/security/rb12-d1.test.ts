import { isHttpError, isRedirect } from '@sveltejs/kit';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { render } from 'svelte/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { sessionCookieName } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import {
	notifications,
	projects,
	savedViews,
	taskLabels,
	tasks,
	taskTeamLabels,
	teamLabels,
	users
} from '#lib/server/db/schema';
import { parseIssueParams } from '#lib/server/issues/filters';
import { listIssues } from '#lib/server/issues/query';
import { bulkUpdate, issuesBulkUpdate } from '#lib/server/pm/bulk';
import { createLabel, deleteLabel, setTaskLabels } from '#lib/server/pm/labels';
import { canonicalizeQuery } from '#lib/server/pm/query';
import { createTeamLabel, deleteTeamLabel, liveLabelCount } from '#lib/server/pm/team-labels';
import { labelNameKey, parseLabel } from '#lib/server/pm/validation';
import { saveView } from '#lib/server/pm/views';
import { createTask } from '#lib/server/tasks/repo';
import LabelChip from '../../src/lib/ui/pm/LabelChip.svelte';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { archive, clearAll, seedProject, seedTask, taskDefaults } from '../helpers/seed-tasks';
import { insertSession, insertUser } from '../helpers/users';

/**
 * Red-team probes for RB-12 issues and team labels against a fresh local D1
 * (docs/features/rb-12-issues-labels/SECURITY_REPORT.md). Tests named `PROOF` document a finding (they assert the
 * weak behaviour as it ships); every other test asserts a defence that holds. Fictional data only.
 */

const binding: {
	DB?: D1Database;
	TEAM_TIME_ZONE: string;
	ACCESS_TEAM_DOMAIN: string;
	ACCESS_AUD: string;
} = { TEAM_TIME_ZONE: 'UTC', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' };
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const { handle } = await import('../../src/hooks.server');
const issuesPage = await import('../../src/routes/(app)/issues/+page.server');
const reportPage = await import('../../src/routes/(app)/issues/new/+page.server');
const labelsApi = await import('../../src/routes/(app)/issues/labels/+server');
const openIssueView = await import('../../src/routes/(app)/issues/views/[id]/+server');
const adminLabels = await import('../../src/routes/(app)/admin/labels/+page.server');
const adminHub = await import('../../src/routes/(app)/admin/+page.server');
const projectLayout = await import('../../src/routes/(app)/projects/[key]/+layout.server');
const projectPage = await import('../../src/routes/(app)/projects/[key]/+page.server');
const taskPage = await import('../../src/routes/(app)/projects/[key]/tasks/[number]/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
beforeAll(async () => {
	const opened = await openLocalD1();
	d1 = opened.db;
	binding.DB = opened.db;
	db = getDb(opened.db);
	dispose = opened.dispose;
});
afterAll(() => dispose());
beforeEach(() => clearAll(db));

type Fn = (event: never) => unknown;
async function run(fn: unknown, event: unknown): Promise<unknown> {
	try {
		return await (fn as Fn)(event as never);
	} catch (e) {
		return e;
	}
}
const status = (r: unknown) =>
	isHttpError(r)
		? r.status
		: isRedirect(r)
			? r.status
			: ((r as { status?: number })?.status ?? 200);
const location = (r: unknown) => (r as { location: string }).location;

function req(
	user: SessionUser | null,
	path: string,
	options: {
		form?: Record<string, string> | [string, string][];
		params?: Record<string, string>;
		database?: Db;
	} = {}
) {
	const { event } = fakeEvent({
		url: `http://localhost${path}`,
		db: options.database ?? db,
		user,
		form: options.form,
		params: options.params
	});
	Object.assign(event, {
		parent: async () => (await projectLayout.load(event as never)) as Record<string, unknown>
	});
	return event;
}

async function world() {
	const admin = await insertUser(db, { role: 'admin', name: 'Ada Admin' });
	const member = await insertUser(db, { name: 'Mia Member' });
	const target = await insertUser(db, { name: 'Tia Target' });
	const disabled = await insertUser(db, { name: 'Dee Disabled', status: 'disabled' });
	const ops = await seedProject(db, admin, { key: 'OPS' });
	const web = await seedProject(db, admin, { key: 'WEB' });
	return { admin, member, target, disabled, ops, web };
}

const teamLabel = async (actor: SessionUser, name: string) => {
	const r = await createTeamLabel(
		db,
		actor,
		{ name, nameKey: labelNameKey(name), color: 'blue' },
		Date.now()
	);
	if (!r.ok) throw new Error(`team label: ${r.reason}`);
	return r.id;
};
const projectLabel = async (projectId: string, actor: SessionUser, name: string) => {
	const r = await createLabel(
		db,
		actor,
		projectId,
		{ name, nameKey: labelNameKey(name), color: 'red' },
		Date.now()
	);
	if (!r.ok) throw new Error(`label: ${r.reason}`);
	return r.id;
};
const countOf = async (table: string) =>
	(await d1.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const liveLabelsOn = async (taskId: string) =>
	Number(
		(
			await db
				.select({ n: sql<number>`${liveLabelCount(taskId)}` })
				.from(sql`(select 1)`)
				.get()
		)?.n ?? 0
	);
const reportForm = (fields: Record<string, string>, extra: [string, string][] = []) =>
	[
		...Object.entries({
			projectKey: 'OPS',
			type: 'bug',
			title: 'The lamp flickers',
			description: '',
			priority: 'none',
			submissionId: crypto.randomUUID(),
			...fields
		}),
		...extra
	] as [string, string][];
const report = (user: SessionUser | null, form: [string, string][]) =>
	run(reportPage.actions.default, req(user, '/issues/new', { form }));

// ── Pipeline: deactivated sessions, CSRF, caching ───────────────────────────────────────────────────────────

describe('pipeline: deactivated users, CSRF and caching on the RB-12 routes', () => {
	const posts: [string, string, Record<string, string>][] = [
		['/issues?/bulk', '/(app)/issues', { taskId: crypto.randomUUID(), status: 'done' }],
		['/issues?/saveView', '/(app)/issues', { name: 'Mine' }],
		['/issues?/deleteView', '/(app)/issues', { id: crypto.randomUUID() }],
		[
			'/issues/new',
			'/(app)/issues/new',
			{ projectKey: 'OPS', type: 'bug', title: 'x', submissionId: crypto.randomUUID() }
		],
		['/admin/labels?/create', '/(app)/admin/labels', { name: 'Evil', color: 'red' }],
		[
			'/admin/labels?/update',
			'/(app)/admin/labels',
			{ id: crypto.randomUUID(), name: 'Evil', color: 'red', expectedUpdatedAt: '1' }
		],
		['/admin/labels?/delete', '/(app)/admin/labels', { id: crypto.randomUUID(), confirm: 'yes' }]
	];

	it('a deactivated user’s live session is dropped before any RB-12 route runs', async () => {
		const w = await world();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const gets: [string, string][] = [
			['/issues', '/(app)/issues'],
			['/issues/new', '/(app)/issues/new'],
			['/issues/labels?project=OPS', '/(app)/issues/labels'],
			[`/issues/views/${crypto.randomUUID()}`, '/(app)/issues/views/[id]'],
			['/admin/labels', '/(app)/admin/labels'],
			['/admin', '/(app)/admin']
		];
		for (const [path, routeId, form] of [
			...posts,
			...gets.map(([p, r]) => [p, r, undefined] as const)
		]) {
			const token = await insertSession(db, w.disabled.id);
			const resolve = vi.fn(async () => new Response('ran'));
			const { event } = fakeEvent({
				url: `http://localhost${path}`,
				routeId,
				db,
				cookies: { [sessionCookieName(false)]: token },
				form: form as Record<string, string> | undefined
			});
			const response = await handle({ event, resolve } as never);
			expect(event.locals.user, path).toBeNull();
			expect(resolve, path).not.toHaveBeenCalled();
			expect([302, 303, 401], path).toContain(response.status);
			expect(response.headers.get('cache-control'), path).toContain('no-store');
		}
	});

	it('CSRF: cross-site and Origin-less POSTs to every RB-12 action are refused before routing', async () => {
		const w = await world();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		for (const [path, routeId, form] of posts)
			for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }]) {
				const token = await insertSession(db, w.admin.id);
				const resolve = vi.fn(async () => new Response('ran'));
				const { event } = fakeEvent({
					url: `http://localhost${path}`,
					routeId,
					db,
					cookies: { [sessionCookieName(false)]: token },
					form,
					headers
				});
				const response = await handle({ event, resolve } as never);
				expect(response.status, path).toBe(403);
				expect(resolve, path).not.toHaveBeenCalled();
			}
		expect(await countOf('team_labels')).toBe(0);
		expect(await countOf('tasks')).toBe(0);
	});

	it('signed-in RB-12 pages and the view opener answer private, no-store', async () => {
		const w = await world();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		for (const [path, routeId] of [
			['/issues', '/(app)/issues'],
			['/issues/new', '/(app)/issues/new'],
			[`/issues/views/${crypto.randomUUID()}`, '/(app)/issues/views/[id]']
		]) {
			const token = await insertSession(db, w.member.id);
			const { event } = fakeEvent({
				url: `http://localhost${path}`,
				routeId,
				db,
				cookies: { [sessionCookieName(false)]: token }
			});
			const response = await handle({
				event,
				resolve: async () => new Response('page', { status: 200 })
			} as never);
			expect(response.headers.get('cache-control'), path).toBe('private, no-store');
		}
		const api = (await labelsApi.GET(
			req(w.member, '/issues/labels?project=OPS') as never
		)) as Response;
		expect(api.headers.get('cache-control')).toBe('private, no-store');
	});
});

// ── Authorization ───────────────────────────────────────────────────────────────────────────────────────────

describe('authorization', () => {
	it('signed out: every RB-12 load, action and endpoint answers 401 and writes nothing', async () => {
		await world();
		const id = crypto.randomUUID();
		const calls: [unknown, string, Record<string, string> | undefined, Record<string, string>?][] =
			[
				[issuesPage.load, '/issues', undefined],
				[issuesPage.actions.bulk, '/issues?/bulk', { taskId: id, status: 'done' }],
				[issuesPage.actions.saveView, '/issues?/saveView', { name: 'x' }],
				[issuesPage.actions.deleteView, '/issues?/deleteView', { id }],
				[reportPage.load, '/issues/new', undefined],
				[reportPage.actions.default, '/issues/new', Object.fromEntries(reportForm({}))],
				[labelsApi.GET, '/issues/labels?project=OPS', undefined],
				[openIssueView.GET, `/issues/views/${id}`, undefined, { id }],
				[adminLabels.load, '/admin/labels', undefined],
				[adminLabels.actions.create, '/admin/labels?/create', { name: 'X', color: 'red' }],
				[adminHub.load, '/admin', undefined]
			];
		for (const [fn, path, form, params] of calls)
			expect(status(await run(fn, req(null, path, { form, params }))), path).toBe(401);
		expect(await countOf('tasks')).toBe(0);
		expect(await countOf('team_labels')).toBe(0);
	});

	it('a member gets 403 on /admin and every /admin/labels load and action; nothing changes', async () => {
		const w = await world();
		const label = await teamLabel(w.admin, 'Security');
		const before = await db.select().from(teamLabels);
		const updatedAt = String(before[0]!.updatedAt);
		expect(status(await run(adminHub.load, req(w.member, '/admin')))).toBe(403);
		expect(status(await run(adminLabels.load, req(w.member, '/admin/labels')))).toBe(403);
		for (const [fn, form] of [
			[adminLabels.actions.create, { name: 'Mine', color: 'red' }],
			[
				adminLabels.actions.update,
				{ id: label, name: 'Renamed', color: 'red', expectedUpdatedAt: updatedAt }
			],
			[adminLabels.actions.delete, { id: label, confirm: 'yes' }]
		] as const)
			expect(status(await run(fn, req(w.member, '/admin/labels', { form })))).toBe(403);
		expect(await db.select().from(teamLabels)).toEqual(before);
	});

	it('an admin demoted or disabled after the session was read cannot change team labels (SQL re-check)', async () => {
		const w = await world();
		const label = await teamLabel(w.admin, 'Security');
		const exAdmin = await insertUser(db, { role: 'admin', name: 'Ex Admin' });
		const offAdmin = await insertUser(db, { role: 'admin', name: 'Off Admin' });
		await db.update(users).set({ role: 'member' }).where(eq(users.id, exAdmin.id));
		await db.update(users).set({ status: 'disabled' }).where(eq(users.id, offAdmin.id));
		const before = await db.select().from(teamLabels);
		const updatedAt = String(before[0]!.updatedAt);
		// `locals.user` still says admin (the stale read); every write re-checks inside its own statement.
		for (const actor of [exAdmin, offAdmin])
			for (const [fn, form] of [
				[adminLabels.actions.create, { name: 'Sneaky', color: 'red' }],
				[
					adminLabels.actions.update,
					{ id: label, name: 'Renamed', color: 'green', expectedUpdatedAt: updatedAt }
				],
				[adminLabels.actions.delete, { id: label, confirm: 'yes' }]
			] as const)
				expect(status(await run(fn, req(actor, '/admin/labels', { form })))).toBe(403);
		expect(await db.select().from(teamLabels)).toEqual(before);
	});
});

// ── Filter and query injection, DoS ─────────────────────────────────────────────────────────────────────────

describe('Issues filters: injection and bounded cost', () => {
	it('hostile values are dropped by the parser, never reach SQL as text', () => {
		const p = parseIssueParams(
			new URLSearchParams(
				[
					'sort=updated;drop table tasks',
					'dir=desc--',
					'page=-1',
					'type=bug%27%20or%201=1',
					"label=' or 1=1 --",
					'project=OPS%27)--',
					'project=../etc',
					'assignee=me%20or%201',
					'reporter=none',
					'milestone=%27',
					'created_from=2024-02-30',
					'created_to=9999-01-01',
					'updated_from=+002024-01-01',
					'updated_to=2024-1-1',
					'archived=true'
				].join('&')
			)
		);
		expect(p.sort).toEqual({ sort: 'updated', dir: 'desc' });
		expect(p.page).toBe(1);
		expect(p.filters).toMatchObject({
			types: [],
			labels: [],
			projects: [],
			assignee: 'any',
			reporter: 'any',
			milestone: 'any',
			createdFrom: null,
			createdTo: null,
			updatedFrom: null,
			updatedTo: null,
			archived: false
		});
		expect(p.ignored).toBeGreaterThanOrEqual(14);
		for (const page of ['201', '999', '1e2', '0x10', '1.5', '00', '9999999999999999'])
			expect(parseIssueParams(new URLSearchParams(`page=${page}`)).page, page).toBe(1);
		expect(parseIssueParams(new URLSearchParams('page=200')).page).toBe(200);
	});

	it('20 000 repeated values are cut to the limits in linear time', () => {
		const q = new URLSearchParams();
		for (let i = 0; i < 20_000; i += 1) {
			q.append('label', crypto.randomUUID());
			q.append('project', `P${i % 9000}`);
			q.append('status', 'todo');
		}
		const started = performance.now();
		const p = parseIssueParams(q);
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(p.filters.labels).toHaveLength(8);
		expect(p.filters.projects).toHaveLength(6);
		expect(p.filters.statuses).toEqual(['todo']);
		// The stored view form stays within its cap whatever was posted.
		expect(canonicalizeQuery('issues', q)!.length).toBeLessThanOrEqual(1000);
	});

	it('a forged filter object (parser bypassed) is bound as data: no rows, no error, nothing dropped', async () => {
		const w = await world();
		await seedTask(db, w.admin, w.ops, { title: 'Real' });
		const p = parseIssueParams(new URLSearchParams());
		const evil = "x') or 1=1; drop table tasks; --";
		const forged = {
			...p.filters,
			types: [evil] as never[],
			labels: [evil],
			projects: [evil],
			assignee: { userId: evil },
			reporter: { userId: evil },
			milestone: { id: evil }
		};
		const r = await listIssues(db, forged, p.sort, 1, w.member.id, 'UTC');
		expect(r).toEqual({ rows: [], total: 0 });
		expect(await countOf('tasks')).toBe(1);
	});

	it('a maximal hostile URL costs the same statements as a plain one, within budget and time', async () => {
		const w = await world();
		const team = await Promise.all(
			Array.from({ length: 4 }, (_, i) => teamLabel(w.admin, `Team ${i}`))
		);
		await d1
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
				 INSERT INTO tasks (id, project_id, number, title, description, status, priority, position, created_by, created_at, updated_at, type)
				 SELECT lower(hex(randomblob(16))), ?1, i, 'Row', '', 'todo', 'none', i, ?2, i * 1000, i * 1000, 'bug' FROM n`
			)
			.bind(w.ops.id, w.admin.id)
			.run();
		const counted = async (q: string) => {
			let n = 0;
			const proxy = new Proxy(d1, {
				get(target, prop) {
					const value = Reflect.get(target, prop);
					if (prop === 'prepare')
						return (query: string) => {
							n += 1;
							return target.prepare(query);
						};
					return typeof value === 'function' ? value.bind(target) : value;
				}
			});
			const started = performance.now();
			const r = await run(
				issuesPage.load,
				req(w.member, `/issues?${q}`, { database: getDb(proxy) })
			);
			expect(status(r)).toBe(200);
			expect((r as { loadError: boolean }).loadError).toBe(false);
			return { n, ms: performance.now() - started };
		};
		const hostile = new URLSearchParams();
		for (const t of ['task', 'bug', 'improvement']) hostile.append('type', t);
		for (const s of ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'])
			hostile.append('status', s);
		for (const id of team) hostile.append('label', id);
		for (let i = 0; i < 2000; i += 1) hostile.append('label', crypto.randomUUID());
		for (const k of ['OPS', 'WEB', 'AAA', 'BBB', 'CCC', 'DDD', 'EEE']) hostile.append('project', k);
		hostile.set('created_from', '2000-01-01');
		hostile.set('created_to', '2100-12-31');
		hostile.set('updated_from', '2000-01-01');
		hostile.set('updated_to', '2100-12-31');
		hostile.set('archived', '1');
		hostile.set('sort', 'priority');
		hostile.set('page', '200');
		const plain = await counted('');
		const worst = await counted(hostile.toString());
		const deep = await counted('sort=due&dir=asc&page=60');
		expect(worst.n).toBeLessThanOrEqual(plain.n + 1);
		expect(deep.n).toBeLessThanOrEqual(plain.n);
		expect(plain.n).toBeLessThanOrEqual(10);
		expect(worst.ms).toBeLessThan(10_000);
		expect(deep.ms).toBeLessThan(10_000);
	});
});

// ── Saved Issues views ──────────────────────────────────────────────────────────────────────────────────────

describe('saved Issues views', () => {
	it('another user’s view: open and delete answer 404, the view stays', async () => {
		const w = await world();
		const saved = await saveView(
			db,
			w.target.id,
			null,
			{ name: 'Theirs', kind: 'issues', query: 'type=bug' },
			Date.now()
		);
		if (!saved.ok) throw new Error('view');
		expect(
			status(
				await run(
					openIssueView.GET,
					req(w.member, `/issues/views/${saved.id}`, { params: { id: saved.id } })
				)
			)
		).toBe(404);
		const upper = saved.id.toUpperCase();
		expect(
			status(
				await run(
					openIssueView.GET,
					req(w.member, `/issues/views/${upper}`, { params: { id: upper } })
				)
			)
		).toBe(404);
		expect(
			status(
				await run(
					issuesPage.actions.deleteView,
					req(w.member, '/issues?/deleteView', { form: { id: saved.id } })
				)
			)
		).toBe(404);
		const row = await db.select().from(savedViews).where(eq(savedViews.id, saved.id)).get();
		expect(row?.deletedAt).toBeNull();
	});

	it('the opener redirects only to /issues, even for a stored query shaped like a URL', async () => {
		const w = await world();
		for (const query of [
			'//evil.example/x',
			'/\\evil.example',
			'x\r\nlocation: https://evil.example'
		]) {
			const id = crypto.randomUUID();
			await db.insert(savedViews).values({
				id,
				userId: w.member.id,
				projectId: null,
				name: `V ${id.slice(0, 6)}`,
				kind: 'issues',
				query,
				createdAt: 1,
				updatedAt: 1
			});
			const r = await run(
				openIssueView.GET,
				req(w.member, `/issues/views/${id}`, { params: { id } })
			);
			if (query.includes('\r')) {
				// SvelteKit refuses a header-breaking location (an error, never an injected header). Unreachable in
				// practice: a stored query is only ever canonicalizeQuery output (URL-encoded).
				expect(isRedirect(r)).toBe(false);
				expect(String(r)).toMatch(/Invalid redirect location/);
				continue;
			}
			expect(status(r)).toBe(303);
			expect(location(r).startsWith('/issues?')).toBe(true);
			expect(new URL(location(r), 'https://ruby.example').origin).toBe('https://ruby.example');
		}
	});

	it('saveView stores only the whitelist from the URL; a posted `query` and `page` are ignored', async () => {
		const w = await world();
		const r = await run(
			issuesPage.actions.saveView,
			req(w.member, '/issues?type=bug&page=3&x=%3Cscript%3E&sort=;drop&/saveView', {
				form: { name: 'Bugs', query: 'project=OPS&evil=1' }
			})
		);
		expect(status(r)).toBe(200);
		const row = await db.select().from(savedViews).where(eq(savedViews.userId, w.member.id)).get();
		expect(row).toMatchObject({ kind: 'issues', projectId: null, query: 'type=bug' });
	});

	it('scopes cannot be mixed: a project form posting kind=issues stores a list view; the table CHECK holds', async () => {
		const w = await world();
		const r = await run(
			projectPage.actions.viewSave,
			req(w.member, '/projects/OPS?/viewSave', {
				form: { name: 'Sneaky', kind: 'issues', query: 'status=todo' },
				params: { key: 'OPS' }
			})
		);
		expect(status(r)).toBe(200);
		const rows = await db.select().from(savedViews);
		expect(rows.map((v) => [v.kind, v.projectId])).toEqual([['list', w.ops.id]]);
		const insert = (kind: string, projectId: string | null) =>
			d1
				.prepare(
					`INSERT INTO saved_views (id, user_id, project_id, name, kind, query, created_at, updated_at) VALUES (?1, ?2, ?3, 'n', ?4, '', 1, 1)`
				)
				.bind(crypto.randomUUID(), w.member.id, projectId, kind)
				.run();
		await expect(insert('issues', w.ops.id)).rejects.toThrow(/CHECK/);
		await expect(insert('list', null)).rejects.toThrow(/CHECK/);
		await expect(insert('evil', null)).rejects.toThrow(/CHECK/);
		expect(
			await saveView(db, w.member.id, w.ops.id, { name: 'x', kind: 'issues', query: '' }, 1)
		).toMatchObject({ ok: false, reason: 'invalid' });
		expect(
			await saveView(db, w.member.id, null, { name: 'x', kind: 'list', query: '' }, 1)
		).toMatchObject({ ok: false, reason: 'invalid' });
	});
});

// ── Label scope IDOR ────────────────────────────────────────────────────────────────────────────────────────

describe('label scopes: deleted team labels, other projects’ labels, project labels across projects', () => {
	it('a deleted team label is refused by set-labels and bulk add; nothing is linked', async () => {
		const w = await world();
		const gone = await teamLabel(w.admin, 'Gone');
		await deleteTeamLabel(db, w.admin, gone, Date.now());
		const t = await seedTask(db, w.member, w.ops);
		expect(
			await setTaskLabels(db, w.ops.id, t.id, { labelIds: [], teamLabelIds: [gone] }, Date.now())
		).toMatchObject({ ok: false, reason: 'invalid' });
		expect(
			await issuesBulkUpdate(db, w.member, [t.id], { addTeamLabelId: gone }, Date.now())
		).toMatchObject({ ok: false });
		expect(
			await bulkUpdate(db, w.member, w.ops.id, [t.id], { addTeamLabelId: gone }, Date.now())
		).toMatchObject({ ok: false });
		expect(await countOf('task_team_labels')).toBe(0);
	});

	it('another project’s label: refused on the task form, in project bulk and on the Report form', async () => {
		const w = await world();
		const foreign = await projectLabel(w.web.id, w.admin, 'Elsewhere');
		const t = await seedTask(db, w.member, w.ops);
		const set = await run(
			taskPage.actions.labelsSet,
			req(w.member, '/projects/OPS/tasks/1?/labelsSet', {
				form: [['labelId', foreign]],
				params: { key: 'OPS', number: '1' }
			})
		);
		expect(status(set)).toBe(400);
		expect(
			await bulkUpdate(db, w.member, w.ops.id, [t.id], { addLabelId: foreign }, Date.now())
		).toMatchObject({ ok: false });
		expect(status(await report(w.member, reportForm({}, [['labelId', foreign]])))).toBe(400);
		// A team label id posted as a project label (wrong scope) is refused too.
		const team = await teamLabel(w.admin, 'Customer');
		expect(status(await report(w.member, reportForm({}, [['labelId', team]])))).toBe(400);
		expect(await countOf('task_labels')).toBe(0);
		expect(await countOf('tasks')).toBe(1);
	});

	it('Issues bulk refuses milestones and project labels, by form and by function; nothing written', async () => {
		const w = await world();
		const own = await projectLabel(w.ops.id, w.admin, 'Lights');
		const t = await seedTask(db, w.member, w.ops, { priority: 'none' });
		for (const field of [
			{ addLabelId: own },
			{ removeLabelId: own },
			{ milestoneId: crypto.randomUUID() }
		]) {
			const r = await run(
				issuesPage.actions.bulk,
				req(w.member, '/issues?/bulk', {
					form: [['taskId', t.id], ['priority', 'urgent'], ...Object.entries(field)]
				})
			);
			expect(status(r), JSON.stringify(field)).toBe(400);
			expect(
				await issuesBulkUpdate(db, w.member, [t.id], { priority: 'urgent', ...field }, Date.now())
			).toMatchObject({ ok: false, reason: 'invalid' });
		}
		const row = await db.select().from(tasks).where(eq(tasks.id, t.id)).get();
		expect(row?.priority).toBe('none');
		expect(await countOf('task_labels')).toBe(0);
	});

	it('Issues bulk: 101 ids, a deleted project’s task, or an archived project’s task fail the whole request', async () => {
		const w = await world();
		const a = await seedTask(db, w.member, w.ops, { priority: 'none' });
		const b = await seedTask(db, w.member, w.web, { priority: 'none' });
		const tooMany = [a.id, ...Array.from({ length: 100 }, () => crypto.randomUUID())];
		expect(
			await issuesBulkUpdate(db, w.member, tooMany, { priority: 'urgent' }, Date.now())
		).toMatchObject({ ok: false });
		await db.update(projects).set({ deletedAt: Date.now() }).where(eq(projects.id, w.web.id));
		expect(
			await issuesBulkUpdate(db, w.member, [a.id, b.id], { priority: 'urgent' }, Date.now())
		).toMatchObject({ ok: false, reason: 'not_found' });
		await db.update(projects).set({ deletedAt: null }).where(eq(projects.id, w.web.id));
		await archive(db, w.web.id);
		expect(
			await issuesBulkUpdate(db, w.member, [a.id, b.id], { priority: 'urgent' }, Date.now())
		).toMatchObject({ ok: false, reason: 'archived' });
		expect((await db.select().from(tasks)).map((t) => t.priority)).toEqual(['none', 'none']);
	});
});

// ── Report an issue: projects and the submission id ─────────────────────────────────────────────────────────

describe('Report an issue: target projects and submission-id idempotency', () => {
	it('archived and deleted projects are refused and never preselected; nothing inserted', async () => {
		const w = await world();
		await archive(db, w.web.id);
		const gone = await seedProject(db, w.admin, { key: 'GONE' });
		await db.update(projects).set({ deletedAt: Date.now() }).where(eq(projects.id, gone.id));
		expect(status(await report(w.member, reportForm({ projectKey: 'WEB' })))).toBe(409);
		expect(status(await report(w.member, reportForm({ projectKey: 'GONE' })))).toBe(404);
		expect(status(await report(w.member, reportForm({ projectKey: 'web' })))).toBe(409);
		for (const key of ['WEB', 'GONE']) {
			const page = (await run(reportPage.load, req(w.member, `/issues/new?project=${key}`))) as {
				projectKey: string | null;
				projects: { key: string }[];
			};
			expect(page.projectKey).toBeNull();
			expect(page.projects.map((p) => p.key)).toEqual(['OPS']);
		}
		const api = (await labelsApi.GET(
			req(w.member, '/issues/labels?project=WEB') as never
		)) as Response;
		expect(await api.json()).toEqual({ labels: [] });
		expect(await countOf('tasks')).toBe(0);
	});

	it('a submission id naming someone else’s task (any case, live or deleted) is refused; that task is untouched', async () => {
		const w = await world();
		const team = await teamLabel(w.admin, 'Customer');
		const victim = await seedTask(db, w.target, w.web, { title: 'Victim task' });
		const deleted = await seedTask(db, w.target, w.ops, { title: 'Deleted task' });
		await db.update(tasks).set({ deletedAt: Date.now() }).where(eq(tasks.id, deleted.id));
		const before = await db.select().from(tasks);
		const counters = await db
			.select({ id: projects.id, n: projects.nextTaskNumber })
			.from(projects);
		for (const id of [victim.id, victim.id.toUpperCase(), ` ${victim.id} `, deleted.id]) {
			const r = await report(
				w.member,
				reportForm({ submissionId: id, projectKey: 'WEB', title: 'Overwrite' }, [
					['teamLabelId', team]
				])
			);
			expect(status(r), id).toBe(400);
		}
		expect(await db.select().from(tasks)).toEqual(before);
		expect(await db.select({ id: projects.id, n: projects.nextTaskNumber }).from(projects)).toEqual(
			counters
		);
		expect(await countOf('task_team_labels')).toBe(0);
	});

	it('the actor’s own task id from another project only redirects to it; nothing is written', async () => {
		const w = await world();
		const mine = await seedTask(db, w.member, w.web, { title: 'Mine' });
		const before = await db.select().from(tasks);
		const r = await report(
			w.member,
			reportForm({ submissionId: mine.id, projectKey: 'OPS', title: 'Changed' })
		);
		expect(location(r)).toMatch(/^\/projects\/WEB\/tasks\/1\?/);
		expect(await db.select().from(tasks)).toEqual(before);
	});

	it('PROOF L1 (fixed): createTask with a taken client id and a refused insert links nothing and bumps no counter', async () => {
		// reportIssue looks the id up first, so this needs the id to appear between that read and the batch while the
		// project is archived meanwhile; the batch itself keys its label links on "a task with this id exists" rather
		// than on its own insert having happened.
		const w = await world();
		const team = await teamLabel(w.admin, 'Customer');
		const victim = await seedTask(db, w.target, w.ops, { title: 'Victim task' });
		await archive(db, w.web.id);
		const counter = async () =>
			(await db
				.select({ n: projects.nextTaskNumber })
				.from(projects)
				.where(eq(projects.id, w.web.id))
				.get())!.n;
		const before = await counter();
		const r = await createTask(
			db,
			w.member,
			{ id: w.web.id },
			taskDefaults({ type: 'bug' }),
			Date.now(),
			{ id: victim.id, labels: { labelIds: [], teamLabelIds: [team] } }
		);
		expect(r).toMatchObject({ ok: false, reason: 'archived' });
		// Fixed (cycle 2): the label links and the counter bump are keyed on the row this batch wrote, so a refused
		// insert writes nothing: the foreign task gets no label and the archived project's counter stays.
		const links = await db
			.select()
			.from(taskTeamLabels)
			.where(and(eq(taskTeamLabels.taskId, victim.id), eq(taskTeamLabels.teamLabelId, team)));
		expect(links).toHaveLength(0);
		expect(await counter()).toBe(before);
	});
});

// ── Combined label cap under concurrency ────────────────────────────────────────────────────────────────────

describe('combined 10-label cap under mixed concurrent writers', () => {
	it('project bulk adds, Issues bulk adds and set-labels at once against a task at 9 never pass 10', async () => {
		const w = await world();
		const own = await Promise.all(
			Array.from({ length: 12 }, (_, i) => projectLabel(w.ops.id, w.admin, `P${i}`))
		);
		const team = await Promise.all(
			Array.from({ length: 12 }, (_, i) => teamLabel(w.admin, `T${i}`))
		);
		const t = await seedTask(db, w.member, w.ops);
		const ok = await setTaskLabels(
			db,
			w.ops.id,
			t.id,
			{ labelIds: own.slice(0, 5), teamLabelIds: team.slice(0, 4) },
			Date.now()
		);
		expect(ok.ok).toBe(true);
		expect(await liveLabelsOn(t.id)).toBe(9);
		await Promise.all([
			...own
				.slice(5)
				.map((id) => bulkUpdate(db, w.member, w.ops.id, [t.id], { addLabelId: id }, Date.now())),
			...team
				.slice(4)
				.map((id) => issuesBulkUpdate(db, w.target, [t.id], { addTeamLabelId: id }, Date.now())),
			setTaskLabels(
				db,
				w.ops.id,
				t.id,
				{ labelIds: own.slice(0, 6), teamLabelIds: team.slice(0, 4) },
				Date.now()
			)
		]);
		expect(await liveLabelsOn(t.id)).toBeLessThanOrEqual(10);
		// The raw link rows (live labels only) agree.
		const rows =
			(await db.select().from(taskLabels).where(eq(taskLabels.taskId, t.id))).length +
			(await db.select().from(taskTeamLabels).where(eq(taskTeamLabels.taskId, t.id))).length;
		expect(rows).toBeLessThanOrEqual(10);
	});

	it('a deleted project label frees a slot; it cannot be revived to push a task past 10', async () => {
		const w = await world();
		const own = await Promise.all(
			Array.from({ length: 11 }, (_, i) => projectLabel(w.ops.id, w.admin, `P${i}`))
		);
		const t = await seedTask(db, w.member, w.ops);
		await setTaskLabels(
			db,
			w.ops.id,
			t.id,
			{ labelIds: own.slice(0, 10), teamLabelIds: [] },
			Date.now()
		);
		await deleteLabel(db, w.admin, w.ops.id, own[0]!, Date.now());
		await bulkUpdate(db, w.member, w.ops.id, [t.id], { addLabelId: own[10]! }, Date.now());
		expect(await liveLabelsOn(t.id)).toBe(10);
		// The posted set may not name the deleted label again.
		expect(
			await setTaskLabels(db, w.ops.id, t.id, { labelIds: [own[0]!], teamLabelIds: [] }, Date.now())
		).toMatchObject({ ok: false });
	});
});

// ── Notifications through cross-project bulk ────────────────────────────────────────────────────────────────

describe('notifications: cross-project bulk assignment', () => {
	it('100 tasks over 5 projects notify at most 10 per request; dedupe, self and disabled assignees hold', async () => {
		const w = await world();
		const extra = await Promise.all(
			['AAA', 'BBB', 'CCC'].map((key) => seedProject(db, w.admin, { key }))
		);
		const all = [w.ops, w.web, ...extra];
		const ids: string[] = [];
		for (const p of all)
			for (let i = 0; i < 20; i += 1) ids.push((await seedTask(db, w.admin, p)).id);
		const unread = async (userId: string) =>
			(
				await db
					.select()
					.from(notifications)
					.where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
			).length;
		const first = await issuesBulkUpdate(
			db,
			w.member,
			ids,
			{ assigneeId: w.target.id },
			Date.now()
		);
		expect(first).toMatchObject({ ok: true, updated: 100, notifySkipped: 90 });
		expect(await unread(w.target.id)).toBe(10);
		// Same assignment again: nothing changes, nobody is notified.
		await issuesBulkUpdate(db, w.member, ids, { assigneeId: w.target.id }, Date.now());
		expect(await unread(w.target.id)).toBe(10);
		// Self-assignment never notifies.
		await issuesBulkUpdate(db, w.member, ids, { assigneeId: w.member.id }, Date.now());
		expect(await unread(w.member.id)).toBe(0);
		// A disabled assignee is refused with nothing written.
		expect(
			await issuesBulkUpdate(db, w.member, ids, { assigneeId: w.disabled.id }, Date.now())
		).toMatchObject({ ok: false, reason: 'invalid' });
		expect(await unread(w.disabled.id)).toBe(0);
		// Flip back: the tasks that already carry an unread notice for the target are skipped; the rest are capped.
		const back = await issuesBulkUpdate(db, w.member, ids, { assigneeId: w.target.id }, Date.now());
		expect(back.ok).toBe(true);
		expect(await unread(w.target.id)).toBe(20);
		const perTask = await d1
			.prepare(
				`SELECT max(c) AS m FROM (SELECT count(*) AS c FROM notifications WHERE user_id = ?1 AND read_at IS NULL GROUP BY target_id)`
			)
			.bind(w.target.id)
			.first<{ m: number }>();
		expect(perTask?.m).toBe(1);
	});
});

// ── XSS in labels and colours ───────────────────────────────────────────────────────────────────────────────

describe('XSS: team label names and colours', () => {
	it('names render as text; a colour outside the allowlist is refused by the parser and by the table', async () => {
		const w = await world();
		const name = '<img src=x onerror=alert(1)>';
		const form = new FormData();
		form.set('name', name);
		form.set('color', 'red" onmouseover="alert(1)');
		expect(parseLabel(form).ok).toBe(false);
		const r = await run(
			adminLabels.actions.create,
			req(w.admin, '/admin/labels?/create', { form: { name, color: 'red' } })
		);
		expect(status(r)).toBe(200);
		const stored = (await db.select().from(teamLabels))[0]!;
		const { body } = render(LabelChip, {
			props: { name: stored.name, color: stored.color, scope: 'team' }
		});
		expect(body).not.toMatch(/<img/i);
		expect(body).toContain('&lt;img');
		await expect(
			d1
				.prepare(
					`INSERT INTO team_labels (id, name, name_key, color, created_by, created_at, updated_at) VALUES (?1, 'n', 'n2', 'javascript:alert(1)', ?2, 1, 1)`
				)
				.bind(crypto.randomUUID(), w.admin.id)
				.run()
		).rejects.toThrow(/CHECK/);
	});
});

// ── Migration 0012 constraints ──────────────────────────────────────────────────────────────────────────────

describe('migration 0012: CHECKs, foreign keys, indexes and FTS triggers', () => {
	it('enforces the type CHECK and the link-table foreign keys; no rebuild leftovers', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		await expect(
			d1.prepare(`UPDATE tasks SET type = 'epic' WHERE id = ?1`).bind(t.id).run()
		).rejects.toThrow(/CHECK/);
		await expect(
			d1
				.prepare(
					`INSERT INTO task_team_labels (task_id, team_label_id, created_at) VALUES (?1, ?2, 1)`
				)
				.bind(t.id, crypto.randomUUID())
				.run()
		).rejects.toThrow(/FOREIGN KEY/);
		await expect(
			d1
				.prepare(
					`INSERT INTO saved_views (id, user_id, project_id, name, kind, query, created_at, updated_at) VALUES (?1, ?2, NULL, 'n', 'issues', '', 1, 1)`
				)
				.bind(crypto.randomUUID(), crypto.randomUUID())
				.run()
		).rejects.toThrow(/FOREIGN KEY/);
		const objects = await d1
			.prepare(
				`SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`
			)
			.all<{ type: string; name: string; tbl_name: string }>();
		const names = objects.results.map((o) => o.name);
		expect(names).not.toContain('saved_views_new');
		expect(names).not.toContain('saved_views_user_project_name_uq');
		expect(names).toEqual(
			expect.arrayContaining([
				'saved_views_project_name_uq',
				'saved_views_issues_name_uq',
				'team_labels_name_uq',
				'tasks_fts_ai',
				'tasks_fts_au',
				'tasks_fts_ad'
			])
		);
		const fk = await d1.prepare('PRAGMA foreign_key_check').all();
		expect(fk.results).toEqual([]);
	});
});
