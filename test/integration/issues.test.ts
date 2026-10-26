import { isHttpError, isRedirect } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { notifications, projects, savedViews, tasks, users } from '#lib/server/db/schema';
import { issueRowsQuery, listIssues } from '#lib/server/issues/query';
import { parseIssueParams } from '#lib/server/issues/filters';
import { issuesBulkUpdate } from '#lib/server/pm/bulk';
import { createLabel, setTaskLabels } from '#lib/server/pm/labels';
import { createTeamLabel, deleteTeamLabel, updateTeamLabel } from '#lib/server/pm/team-labels';
import { labelNameKey, PM_LIMITS, PM_MESSAGES } from '#lib/server/pm/validation';
import { THROTTLE_MINUTE_MS, THROTTLE_WINDOW_MS } from '#lib/server/auth/throttle';
import { saveView } from '#lib/server/pm/views';
import { searchAll } from '#lib/server/search/repo';
import { patchTask } from '#lib/server/tasks/repo';
import { parsePatch } from '#lib/server/tasks/validation';
import { renderMarkdown } from '#lib/shared/markdown';
import { pinToWindowStart } from '../helpers/clock';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { archive, clearAll, seedProject, seedTask, taskRow } from '../helpers/seed-tasks';
import { insertUser } from '../helpers/users';

/**
 * RB-12 against local D1: task types, team labels and the combined label cap, the Issues list (filters, sort,
 * pages, capped count, statement budget, query plans), cross-project bulk, Report an issue, Issues saved views and
 * the admin labels page, through the repos and the route loads/actions. Fictional data only.
 */

const binding: { DB?: D1Database; TEAM_TIME_ZONE: string } = { TEAM_TIME_ZONE: 'Asia/Jakarta' };
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const issuesPage = await import('../../src/routes/(app)/issues/+page.server');
const reportPage = await import('../../src/routes/(app)/issues/new/+page.server');
const labelsApi = await import('../../src/routes/(app)/issues/labels/+server');
const openIssueView = await import('../../src/routes/(app)/issues/views/[id]/+server');
const adminLabels = await import('../../src/routes/(app)/admin/labels/+page.server');
const projectLayout = await import('../../src/routes/(app)/projects/[key]/+layout.server');
const projectPage = await import('../../src/routes/(app)/projects/[key]/+page.server');
const openProjectView = await import('../../src/routes/(app)/projects/[key]/views/[id]/+server');
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
const pm = (r: unknown) =>
	((r as { data?: { pm?: Record<string, unknown> } }).data?.pm ??
		(r as { pm?: Record<string, unknown> }).pm) as {
		ok: boolean;
		message: string;
		errors?: Record<string, string>;
		id?: string;
	};
const dataOf = <T>(r: unknown) => ((r as { data?: T }).data ?? r) as T;

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

const DAY = 24 * 60 * 60 * 1000;
const NONE = '00000000-0000-4000-8000-000000000000';

async function world() {
	const admin = await insertUser(db, { role: 'admin', name: 'Ada Admin' });
	const member = await insertUser(db, { name: 'Mia Member' });
	const other = await insertUser(db, { name: 'Oli Other' });
	const ops = await seedProject(db, admin, { key: 'OPS' });
	const web = await seedProject(db, admin, { key: 'WEB' });
	return { admin, member, other, ops, web };
}

const teamLabel = async (actor: SessionUser, name: string, color = 'blue' as const) => {
	const r = await createTeamLabel(
		db,
		actor,
		{ name, nameKey: labelNameKey(name), color },
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
const parse = (q: string) => parseIssueParams(new URLSearchParams(q));
const list = async (viewer: SessionUser, q = '') => {
	const p = parse(q);
	return listIssues(db, p.filters, p.sort, p.page, viewer.id, 'Asia/Jakarta');
};
const keysOf = (rows: { projectKey: string; number: number }[]) =>
	rows.map((r) => `${r.projectKey}-${r.number}`).sort();

// ── Migration 0012 ──────────────────────────────────────────────────────────────────────────────────────────

describe('migration 0012', () => {
	it('keeps every task (type task), the FTS triggers and hits, and every saved_views row and index', async () => {
		const old = await openLocalD1({ before: '0012' });
		try {
			const run1 = (q: string, ...a: unknown[]) =>
				old.db
					.prepare(q)
					.bind(...a)
					.run();
			const u = await insertUser(getDb(old.db));
			await run1(
				`INSERT INTO projects (id, key, name, status, created_by, created_at, updated_at) VALUES ('p1', 'OLD', 'Old', 'active', ?1, 1, 1)`,
				u.id
			);
			for (const [id, n, title, deleted] of [
				['t1', 1, 'Legacy lighthouse task', null],
				['t2', 2, 'Harbour lighthouse repair', null],
				['t3', 3, 'Removed lighthouse note', 5]
			] as const)
				await run1(
					`INSERT INTO tasks (id, project_id, number, title, description, status, created_by, created_at, updated_at, deleted_at) VALUES (?1, 'p1', ?2, ?3, 'Body', 'todo', ?4, 1, 1, ?5)`,
					id,
					n,
					title,
					u.id,
					deleted
				);
			for (const [id, name, kind, query, deleted] of [
				['v1', 'Mine', 'list', 'status=todo', null],
				['v2', 'Board', 'board', 'view=board&priority=high', null],
				['v3', 'Gone', 'list', '', 9]
			] as const)
				await run1(
					`INSERT INTO saved_views (id, user_id, project_id, name, kind, query, created_at, updated_at, deleted_at) VALUES (?1, ?2, 'p1', ?3, ?4, ?5, 2, 3, ?6)`,
					id,
					u.id,
					name,
					kind,
					query,
					deleted
				);
			const ftsHits = async () =>
				(
					await old.db
						.prepare(
							`SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH 'lighthouse' ORDER BY rowid`
						)
						.all<{ rowid: number }>()
				).results.map((r) => r.rowid);
			const views = async () =>
				(await old.db.prepare('SELECT * FROM saved_views ORDER BY id').all()).results;
			const taskIds = async () =>
				(await old.db.prepare('SELECT id FROM tasks ORDER BY id').all<{ id: string }>()).results;
			const beforeHits = await ftsHits();
			const beforeViews = await views();
			const beforeTasks = await taskIds();
			expect(beforeHits).toHaveLength(3);

			const { applyMigration } = await import('../helpers/d1');
			await applyMigration(old.db, '0012_issues_labels.sql');

			expect(await taskIds()).toEqual(beforeTasks);
			const types = await old.db.prepare('SELECT DISTINCT type FROM tasks').all<{ type: string }>();
			expect(types.results).toEqual([{ type: 'task' }]);
			expect(await ftsHits()).toEqual(beforeHits);
			expect(await views()).toEqual(beforeViews);
			// D1 does not authorise `integrity_check`; `quick_check` is its allowed form (all but the index content).
			const integrity = await old.db.prepare('PRAGMA quick_check').all<{ quick_check: string }>();
			expect(integrity.results).toEqual([{ quick_check: 'ok' }]);
			expect((await old.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
			const triggers = await old.db
				.prepare(
					`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'tasks' ORDER BY name`
				)
				.all<{ name: string }>();
			expect(triggers.results.map((t) => t.name)).toEqual([
				'tasks_fts_ad',
				'tasks_fts_ai',
				'tasks_fts_au'
			]);
			const indexes = await old.db
				.prepare(
					`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'saved_views' AND sql IS NOT NULL ORDER BY name`
				)
				.all<{ name: string }>();
			expect(indexes.results.map((i) => i.name)).toEqual([
				'saved_views_issues_name_uq',
				'saved_views_project_name_uq'
			]);
			// The scope CHECK: a project view without a project, and an Issues view with one, are both refused.
			await expect(
				run1(
					`INSERT INTO saved_views (id, user_id, project_id, name, kind, query, created_at, updated_at) VALUES ('v4', ?1, NULL, 'X', 'list', '', 1, 1)`,
					u.id
				)
			).rejects.toThrow(/CHECK/);
			await expect(
				run1(
					`INSERT INTO saved_views (id, user_id, project_id, name, kind, query, created_at, updated_at) VALUES ('v5', ?1, 'p1', 'Y', 'issues', '', 1, 1)`,
					u.id
				)
			).rejects.toThrow(/CHECK/);
			await run1(
				`INSERT INTO saved_views (id, user_id, project_id, name, kind, query, created_at, updated_at) VALUES ('v6', ?1, NULL, 'Mine', 'issues', '', 1, 1)`,
				u.id
			);
			await expect(
				run1(
					`INSERT INTO saved_views (id, user_id, project_id, name, kind, query, created_at, updated_at) VALUES ('v7', ?1, NULL, 'Mine', 'issues', '', 1, 1)`,
					u.id
				)
			).rejects.toThrow(/UNIQUE/);
			// The type CHECK refuses anything outside the four types.
			await expect(run1(`UPDATE tasks SET type = 'epic' WHERE id = 't1'`)).rejects.toThrow(/CHECK/);
			// A type change is no FTS event; a title edit still re-indexes.
			const rows = async () =>
				(await old.db.prepare('SELECT count(*) AS n FROM tasks_fts').first<{ n: number }>())!.n;
			const before = await rows();
			await run1(`UPDATE tasks SET type = 'bug' WHERE id = 't1'`);
			expect(await rows()).toBe(before);
			expect(await ftsHits()).toEqual(beforeHits);
			await run1(`UPDATE tasks SET title = 'Renamed beacon task' WHERE id = 't1'`);
			const beacon = await old.db
				.prepare(`SELECT count(*) AS n FROM tasks_fts WHERE tasks_fts MATCH 'beacon'`)
				.first<{ n: number }>();
			expect(beacon!.n).toBe(1);
		} finally {
			await old.dispose();
		}
	});
});

// ── Task types ──────────────────────────────────────────────────────────────────────────────────────────────

describe('task types', () => {
	it('a task can be created and patched to each type; unknown types are field errors', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops, { type: 'bug' });
		expect((await taskRow(db, t.id))!.type).toBe('bug');
		for (const type of ['task', 'feature_request', 'improvement', 'bug'] as const) {
			const row = (await taskRow(db, t.id))!;
			const r = await patchTask(
				db,
				w.member,
				w.ops,
				{ id: t.id, assigneeId: null },
				'type',
				type,
				row.updatedAt,
				Date.now()
			);
			expect(r.ok).toBe(true);
			expect((await taskRow(db, t.id))!.type).toBe(type);
		}
		const form = new FormData();
		form.set('field', 'type');
		form.set('value', 'epic');
		expect(parsePatch(form)).toMatchObject({ ok: false, field: 'type', error: 'Choose a type.' });
		// A stale version is a conflict, as for every other field.
		const stale = await patchTask(
			db,
			w.member,
			w.ops,
			{ id: t.id, assigneeId: null },
			'type',
			'task',
			1,
			Date.now()
		);
		expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
	});

	it('the type is on search hits, and FTS follows create, edit, delete and restore of a typed task', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops, { title: 'Quartz relay fault', type: 'bug' });
		expect((await searchAll(db, 'quartz', { type: 'tasks' })).tasks.map((h) => h.type)).toEqual([
			'bug'
		]);
		await db.update(tasks).set({ title: 'Garnet relay fault' }).where(eq(tasks.id, t.id));
		expect((await searchAll(db, 'quartz', { type: 'tasks' })).tasks).toHaveLength(0);
		expect((await searchAll(db, 'garnet', { type: 'tasks' })).tasks).toHaveLength(1);
		await db.update(tasks).set({ deletedAt: 1 }).where(eq(tasks.id, t.id));
		expect((await searchAll(db, 'garnet', { type: 'tasks' })).tasks).toHaveLength(0);
		await db.update(tasks).set({ deletedAt: null }).where(eq(tasks.id, t.id));
		expect((await searchAll(db, 'garnet', { type: 'tasks' })).tasks).toHaveLength(1);
	});
});

// ── Team labels ─────────────────────────────────────────────────────────────────────────────────────────────

describe('team labels', () => {
	it('admin creates; a case-variant name, a 31-char name, a bad colour and the 101st are refused', async () => {
		const w = await world();
		const add = (user: SessionUser, form: Record<string, string>) =>
			run(adminLabels.actions.create, req(user, '/admin/labels?/create', { form }));
		expect(pm(await add(w.admin, { name: 'Urgent care', color: 'blue' })).ok).toBe(true);
		const dup = await add(w.admin, { name: 'urgent CARE', color: 'red' });
		expect(status(dup)).toBe(400);
		expect(pm(dup).message).toBe('That label already exists.');
		expect(status(await add(w.admin, { name: 'x'.repeat(31), color: 'red' }))).toBe(400);
		expect(status(await add(w.admin, { name: 'Fine', color: 'teal' }))).toBe(400);
		for (let i = 1; i < 100; i++)
			await d1
				.prepare(
					`INSERT INTO team_labels (id, name, name_key, color, created_by, created_at, updated_at) VALUES (?1, ?2, ?2, 'gray', ?3, 1, 1)`
				)
				.bind(crypto.randomUUID(), `l${i}`, w.admin.id)
				.run();
		const over = await add(w.admin, { name: 'One too many', color: 'red' });
		expect(status(over)).toBe(400);
		expect(pm(over).message).toMatch(/up to 100/);
	});

	it('20 concurrent creates at 99 leave exactly 100', async () => {
		const w = await world();
		for (let i = 0; i < 99; i++)
			await d1
				.prepare(
					`INSERT INTO team_labels (id, name, name_key, color, created_by, created_at, updated_at) VALUES (?1, ?2, ?2, 'gray', ?3, 1, 1)`
				)
				.bind(crypto.randomUUID(), `l${i}`, w.admin.id)
				.run();
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				createTeamLabel(db, w.admin, { name: `race${i}`, nameKey: `race${i}`, color: 'red' }, 2)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		const n = await d1
			.prepare('SELECT count(*) AS n FROM team_labels WHERE deleted_at IS NULL')
			.first<{ n: number }>();
		expect(n!.n).toBe(100);
	});

	it('members cannot create, rename, recolour or delete, even by posting directly; nothing changes', async () => {
		const w = await world();
		const id = await teamLabel(w.admin, 'Security');
		const before = await d1.prepare('SELECT * FROM team_labels').all();
		const calls = [
			[adminLabels.actions.create, { name: 'Sneaky', color: 'red' }],
			[adminLabels.actions.update, { id, name: 'Renamed', color: 'red', expectedUpdatedAt: '1' }],
			[adminLabels.actions.delete, { id, confirm: 'yes' }]
		] as const;
		for (const [fn, form] of calls)
			expect(status(await run(fn, req(w.member, '/admin/labels', { form })))).toBe(403);
		expect(status(await run(adminLabels.load, req(w.member, '/admin/labels')))).toBe(403);
		for (const [fn, form] of calls)
			expect(status(await run(fn, req(null, '/admin/labels', { form })))).toBe(401);
		expect(status(await run(adminLabels.load, req(null, '/admin/labels')))).toBe(401);
		// The repo checks the role inside its statement too (a demoted admin writes nothing).
		expect(
			await createTeamLabel(db, w.member, { name: 'X', nameKey: 'x', color: 'red' }, 1)
		).toMatchObject({
			ok: false,
			reason: 'forbidden'
		});
		expect(await deleteTeamLabel(db, w.member, id, 1)).toMatchObject({
			ok: false,
			reason: 'forbidden'
		});
		expect((await d1.prepare('SELECT * FROM team_labels').all()).results).toEqual(before.results);
	});

	it('rename against a stale version is a conflict; delete frees the name, removes it everywhere and counts usage', async () => {
		const w = await world();
		const id = await teamLabel(w.admin, 'Customer');
		const t = await seedTask(db, w.member, w.ops);
		await setTaskLabels(db, w.ops.id, t.id, { labelIds: [], teamLabelIds: [id] }, 1);
		const page = dataOf<{ labels: { id: string; used: number }[] }>(
			await run(adminLabels.load, req(w.admin, '/admin/labels'))
		);
		expect(page.labels).toEqual([expect.objectContaining({ id, used: 1 })]);
		expect(
			await updateTeamLabel(
				db,
				w.admin,
				id,
				{ name: 'Client', nameKey: 'client', color: 'red' },
				1,
				2
			)
		).toMatchObject({ ok: false, reason: 'conflict' });
		expect(
			status(await run(adminLabels.actions.delete, req(w.admin, '/admin/labels', { form: { id } })))
		).toBe(400);
		expect(
			pm(
				await run(
					adminLabels.actions.delete,
					req(w.admin, '/admin/labels', { form: { id, confirm: 'yes' } })
				)
			).ok
		).toBe(true);
		expect((await list(w.admin)).rows[0]!.labels).toEqual([]);
		expect(await teamLabel(w.admin, 'customer')).toBeTruthy();
		// Applying the deleted label is refused, nothing changed.
		expect(
			await setTaskLabels(db, w.ops.id, t.id, { labelIds: [], teamLabelIds: [id] }, 3)
		).toMatchObject({ ok: false, reason: 'invalid' });
	});
});

// ── Labels on tasks (combined cap) ──────────────────────────────────────────────────────────────────────────

describe('project and team labels together', () => {
	it('a task carries both kinds; the 11th of either kind is refused with nothing changed', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		const team = await Promise.all(
			Array.from({ length: 5 }, (_, i) => teamLabel(w.admin, `team${i}`))
		);
		const own: string[] = [];
		for (let i = 0; i < 6; i++) own.push(await projectLabel(w.ops.id, w.admin, `own${i}`));
		expect(
			(
				await setTaskLabels(
					db,
					w.ops.id,
					t.id,
					{ labelIds: own.slice(0, 5), teamLabelIds: team },
					1
				)
			).ok
		).toBe(true);
		expect(
			await setTaskLabels(db, w.ops.id, t.id, { labelIds: own, teamLabelIds: team }, 2)
		).toMatchObject({ ok: false, reason: 'limit' });
		const shown = (await list(w.member)).rows[0]!.labels;
		expect(shown.filter((l) => l.scope === 'team')).toHaveLength(5);
		expect(shown.filter((l) => l.scope === 'project')).toHaveLength(5);
		// A project label of another project is never accepted.
		const foreign = await projectLabel(w.web.id, w.admin, 'foreign');
		expect(
			await setTaskLabels(db, w.ops.id, t.id, { labelIds: [foreign], teamLabelIds: [] }, 3)
		).toMatchObject({ ok: false, reason: 'invalid' });
		expect((await list(w.member)).rows[0]!.labels).toHaveLength(10);
		// The task detail's form sets both kinds.
		const saved = await run(
			taskPage.actions.labelsSet,
			req(w.member, '/projects/OPS/tasks/1', {
				params: { key: 'OPS', number: '1' },
				form: [
					['labelId', own[0]!],
					['teamLabelId', team[0]!]
				]
			})
		);
		expect(pm(saved).ok).toBe(true);
		expect((await list(w.member)).rows[0]!.labels.map((l) => l.id).sort()).toEqual(
			[own[0]!, team[0]!].sort()
		);
	});

	it('20 concurrent team-label adds against a task at 9 labels end at exactly 10', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		const base: string[] = [];
		for (let i = 0; i < 9; i++) base.push(await projectLabel(w.ops.id, w.admin, `b${i}`));
		await setTaskLabels(db, w.ops.id, t.id, { labelIds: base, teamLabelIds: [] }, 1);
		const team = [];
		for (let i = 0; i < 20; i++) team.push(await teamLabel(w.admin, `t${i}`));
		await Promise.all(
			team.map((id) => issuesBulkUpdate(db, w.member, [t.id], { addTeamLabelId: id }, 2))
		);
		const n = await d1
			.prepare(
				`SELECT (SELECT count(*) FROM task_labels WHERE task_id = ?1) + (SELECT count(*) FROM task_team_labels WHERE task_id = ?1) AS n`
			)
			.bind(t.id)
			.first<{ n: number }>();
		expect(n!.n).toBe(10);
	});

	it('the project list and board filter on a team label (OR with project labels)', async () => {
		const w = await world();
		const team = await teamLabel(w.admin, 'Customer');
		const own = await projectLabel(w.ops.id, w.admin, 'Bug');
		const a = await seedTask(db, w.member, w.ops, { title: 'A' });
		const b = await seedTask(db, w.member, w.ops, { title: 'B' });
		await seedTask(db, w.member, w.ops, { title: 'C' });
		await setTaskLabels(db, w.ops.id, a.id, { labelIds: [], teamLabelIds: [team] }, 1);
		await setTaskLabels(db, w.ops.id, b.id, { labelIds: [own], teamLabelIds: [] }, 1);
		const load = async (q: string) =>
			dataOf<{
				list: { rows: { id: string }[] } | null;
				board: { tasks: { id: string }[] }[] | null;
			}>(
				await run(projectPage.load, req(w.member, `/projects/OPS${q}`, { params: { key: 'OPS' } }))
			);
		expect((await load(`?label=${team}`)).list!.rows.map((r) => r.id)).toEqual([a.id]);
		expect((await load(`?label=${team}&label=${own}`)).list!.rows.map((r) => r.id).sort()).toEqual(
			[a.id, b.id].sort()
		);
		const board = (await load(`?view=board&label=${team}`)).board!;
		expect(board.flatMap((c) => c.tasks.map((t) => t.id))).toEqual([a.id]);
	});
});

// ── The Issues list ─────────────────────────────────────────────────────────────────────────────────────────

describe('Issues list', () => {
	it('lists live tasks of live projects; archived only with archived=1; deleted never', async () => {
		const w = await world();
		await seedTask(db, w.member, w.ops, { title: 'live' });
		const gone = await seedTask(db, w.member, w.ops, { title: 'gone' });
		await db.update(tasks).set({ deletedAt: 1 }).where(eq(tasks.id, gone.id));
		const old = await seedProject(db, w.admin, { key: 'OLD' });
		await seedTask(db, w.member, old, { title: 'archived' });
		await archive(db, old.id);
		const dead = await seedProject(db, w.admin, { key: 'DEAD' });
		await seedTask(db, w.member, dead, { title: 'dead project' });
		await db.update(projects).set({ deletedAt: 1 }).where(eq(projects.id, dead.id));
		expect(keysOf((await list(w.member)).rows)).toEqual(['OPS-1']);
		expect(keysOf((await list(w.member, 'archived=1')).rows)).toEqual(['OLD-1', 'OPS-1']);
	});

	it('each filter returns exactly its rows; AND across, OR within; dates inclusive in the team zone', async () => {
		const w = await world();
		const team = await teamLabel(w.admin, 'Customer');
		const own = await projectLabel(w.web.id, w.admin, 'Mobile');
		// 2026-10-26 00:00 in Asia/Jakarta (UTC+7) is 2026-10-25 17:00 UTC.
		const midnight = Date.UTC(2026, 9, 25, 17, 0, 0);
		const bug = await seedTask(
			db,
			w.member,
			w.ops,
			{ type: 'bug', status: 'todo', priority: 'high', assigneeId: w.member.id },
			midnight
		);
		const idea = await seedTask(
			db,
			w.other,
			w.web,
			{ type: 'feature_request', status: 'backlog', priority: 'low' },
			midnight - 1
		);
		const plain = await seedTask(db, w.admin, w.web, { status: 'done' }, midnight + DAY);
		await setTaskLabels(db, w.ops.id, bug.id, { labelIds: [], teamLabelIds: [team] }, 1);
		await setTaskLabels(db, w.web.id, idea.id, { labelIds: [own], teamLabelIds: [] }, 1);
		const ids = async (q: string, viewer = w.member) =>
			(await list(viewer, q)).rows.map((r) => r.id).sort();
		const sorted = (...x: string[]) => x.sort();
		expect(await ids('type=bug')).toEqual([bug.id]);
		expect(await ids('type=bug&type=feature_request')).toEqual(sorted(bug.id, idea.id));
		expect(await ids('status=done')).toEqual([plain.id]);
		expect(await ids('priority=low&priority=high')).toEqual(sorted(bug.id, idea.id));
		expect(await ids(`label=${team}`)).toEqual([bug.id]);
		expect(await ids(`label=${team}&label=${own}`)).toEqual(sorted(bug.id, idea.id));
		expect(await ids('assignee=me')).toEqual([bug.id]);
		expect(await ids('assignee=none')).toEqual(sorted(idea.id, plain.id));
		expect(await ids(`assignee=${w.member.id}`)).toEqual([bug.id]);
		expect(await ids('reporter=me')).toEqual([bug.id]);
		expect(await ids(`reporter=${w.other.id}`)).toEqual([idea.id]);
		expect(await ids('project=web')).toEqual(sorted(idea.id, plain.id));
		expect(await ids('project=OPS&project=WEB')).toHaveLength(3);
		expect(await ids('milestone=none')).toHaveLength(3);
		expect(await ids('created_from=2026-10-26&created_to=2026-10-26')).toEqual([bug.id]);
		expect(await ids('created_to=2026-10-25')).toEqual([idea.id]);
		expect(await ids('created_from=2026-10-27')).toEqual([plain.id]);
		expect(await ids('updated_from=2026-10-26&updated_to=2026-10-27')).toEqual(
			sorted(bug.id, plain.id)
		);
		// AND across groups.
		expect(await ids('type=bug&project=WEB')).toEqual([]);
		expect(await ids('project=WEB&priority=low')).toEqual([idea.id]);
	});

	it('sorts are stable; page 3 of 120 rows holds rows 101-120; the total caps at 10 001', async () => {
		const w = await world();
		await d1
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120)
				 INSERT INTO tasks (id, project_id, number, title, description, status, priority, position, created_by, created_at, updated_at, type)
				 SELECT printf('00000000-0000-4000-8000-%012d', i), ?1, i, 'Row ' || i, '', 'todo', CASE i % 3 WHEN 0 THEN 'high' ELSE 'none' END, i, ?2, i, 1000 + (i % 7), 'task' FROM n`
			)
			.bind(w.ops.id, w.admin.id)
			.run();
		const all = [];
		for (const page of [1, 2, 3]) all.push(...(await list(w.member, `page=${page}`)).rows);
		expect(all).toHaveLength(120);
		expect(new Set(all.map((r) => r.id)).size).toBe(120);
		const third = await list(w.member, 'page=3');
		expect(third.rows).toHaveLength(20);
		expect(third.total).toBe(120);
		// Updated desc, then id desc: a stable order across pages.
		const expected = [...all].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
		expect(all.map((r) => r.id)).toEqual(expected.map((r) => r.id));
		expect(third.rows.map((r) => r.id)).toEqual(expected.slice(100).map((r) => r.id));
		for (const q of ['page=201', 'page=abc'])
			expect((await list(w.member, q)).rows.map((r) => r.id)).toEqual(
				expected.slice(0, 50).map((r) => r.id)
			);
		const byPriority = (await list(w.member, 'sort=priority')).rows;
		expect(byPriority.slice(0, 40).every((r) => r.priority === 'high')).toBe(true);
		const byCreatedAsc = (await list(w.member, 'sort=created&dir=asc')).rows;
		expect(byCreatedAsc[0]!.number).toBe(1);
		// No due date sorts last either way.
		await db.update(tasks).set({ dueOn: '2026-11-01' }).where(eq(tasks.number, 7));
		for (const dir of ['asc', 'desc'])
			expect((await list(w.member, `sort=due&dir=${dir}`)).rows[0]!.number).toBe(7);

		await d1
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10001)
				 INSERT INTO tasks (id, project_id, number, title, description, status, priority, position, created_by, created_at, updated_at, type)
				 SELECT lower(hex(randomblob(16))), ?1, 1000 + i, 'Bulk', '', 'todo', 'none', i, ?2, i, i, 'task' FROM n`
			)
			.bind(w.web.id, w.admin.id)
			.run();
		expect((await list(w.member)).total).toBe(10_001);
		expect((await list(w.member, 'project=OPS')).total).toBe(120);
	});

	it('the page drops invalid and stale filters with a notice instead of failing', async () => {
		const w = await world();
		await seedTask(db, w.member, w.ops);
		const r = dataOf<{
			ignored: number;
			stale: number;
			rows: unknown[];
			filters: { projects: string[] };
		}>(
			await run(
				issuesPage.load,
				req(
					w.member,
					`/issues?type=epic&label=nope&created_from=2026-02-30&project=GONE&label=${NONE}`
				)
			)
		);
		expect(r.ignored).toBe(3);
		expect(r.stale).toBe(2);
		expect(r.filters.projects).toEqual([]);
		expect(r.rows).toHaveLength(1);
		expect(status(await run(issuesPage.load, req(null, '/issues')))).toBe(401);
	});

	it('statements per load are the same for 10 and 500 tasks and within the budget; plans use indexes', async () => {
		const w = await world();
		const team = await teamLabel(w.admin, 'Customer');
		const seed = (projectId: string, n: number) =>
			d1
				.prepare(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
					 INSERT INTO tasks (id, project_id, number, title, description, status, priority, position, created_by, created_at, updated_at, type)
					 SELECT lower(hex(randomblob(16))), ?1, i, 'Row', '', 'todo', 'none', i, ?2, i, i, 'bug' FROM n`
				)
				.bind(projectId, w.admin.id, n)
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
			const r = await run(
				issuesPage.load,
				req(w.member, `/issues${q}`, { database: getDb(proxy) })
			);
			expect(status(r)).toBe(200);
			return n;
		};
		await seed(w.ops.id, 10);
		const small = await counted('');
		const smallOne = await counted('?project=OPS');
		await seed(w.web.id, 500);
		await d1
			.prepare(
				`INSERT INTO task_team_labels (task_id, team_label_id, created_at) SELECT id, ?1, 1 FROM tasks`
			)
			.bind(team)
			.run();
		expect(await counted('')).toBe(small);
		expect(await counted('?project=OPS')).toBe(smallOne);
		expect(small).toBeLessThanOrEqual(10);
		expect(smallOne).toBeLessThanOrEqual(11);

		const plan = async (q: string) => {
			const p = parse(q);
			const { sql: text, params } = issueRowsQuery(
				db,
				p.filters,
				p.sort,
				1,
				w.member.id,
				'UTC'
			).toSQL();
			const rows = await d1
				.prepare(`EXPLAIN QUERY PLAN ${text}`)
				.bind(...params)
				.all<{ detail: string }>();
			return rows.results.map((r) => r.detail).join('\n');
		};
		const fullScan = /SCAN (tasks|"tasks")(?! USING)/;
		for (const q of [
			'',
			'type=bug',
			`reporter=${w.member.id}`,
			`assignee=${w.member.id}`,
			'project=OPS',
			`label=${team}`,
			'sort=created'
		]) {
			const text = await plan(q);
			expect(text, `${q}: ${text}`).not.toMatch(fullScan);
		}
	});
});

// ── Bulk across projects ────────────────────────────────────────────────────────────────────────────────────

describe('Issues bulk', () => {
	async function spread(w: Awaited<ReturnType<typeof world>>, per: number, count = 5) {
		const out: { id: string; projectId: string; number: number }[] = [];
		const projectsList = [w.ops, w.web];
		for (let p = 2; p < count; p++)
			projectsList.push(await seedProject(db, w.admin, { key: `B${p}X` }));
		for (const project of projectsList)
			for (let i = 0; i < per; i++) {
				const t = await seedTask(db, w.admin, project);
				out.push({ ...t, projectId: project.id });
			}
		return { tasks: out, projects: projectsList };
	}

	it('100 tasks across 5 projects in one request; 101 refused; positions per project; completed_at', async () => {
		const w = await world();
		const team = await teamLabel(w.admin, 'Customer');
		const { tasks: all } = await spread(w, 21);
		const ids = all.slice(0, 100).map((t) => t.id);
		const r = await issuesBulkUpdate(
			db,
			w.member,
			ids,
			{
				status: 'done',
				priority: 'high',
				type: 'bug',
				assigneeId: w.other.id,
				dueOn: '2026-12-01',
				addTeamLabelId: team
			},
			Date.now()
		);
		expect(r).toMatchObject({ ok: true, updated: 100 });
		const rows = await db
			.select()
			.from(tasks)
			.where(sql`${tasks.id} in (select value from json_each(${JSON.stringify(ids)}))`);
		expect(
			rows.every((t) => t.status === 'done' && t.type === 'bug' && t.completedAt !== null)
		).toBe(true);
		// Each task at the bottom of its own project's Done column, ascending by number.
		for (const projectId of new Set(rows.map((t) => t.projectId))) {
			const mine = rows
				.filter((t) => t.projectId === projectId)
				.sort((a, b) => a.number - b.number);
			const positions = mine.map((t) => t.position);
			expect(positions).toEqual([...positions].sort((a, b) => a - b));
			expect(new Set(positions).size).toBe(positions.length);
		}
		const links = await d1
			.prepare('SELECT count(*) AS n FROM task_team_labels')
			.first<{ n: number }>();
		expect(links!.n).toBe(100);
		const sent = await db.select().from(notifications).where(eq(notifications.userId, w.other.id));
		expect(sent.length).toBeLessThanOrEqual(10);
		expect(r.ok && r.notifySkipped).toBe(90);
		expect(
			await issuesBulkUpdate(
				db,
				w.member,
				all.slice(0, 101).map((t) => t.id),
				{ priority: 'low' },
				1
			)
		).toMatchObject({ ok: false, reason: 'invalid' });
		// Reopening clears completed_at.
		await issuesBulkUpdate(db, w.member, ids.slice(0, 3), { status: 'todo' }, Date.now());
		expect((await taskRow(db, ids[0]!))!.completedAt).toBeNull();
	});

	it('a deleted task or an archived project fails the whole request with nothing written (404 / 409)', async () => {
		const w = await world();
		const { tasks: all, projects: ps } = await spread(w, 3, 3);
		const ids = all.map((t) => t.id);
		const snapshot = async () =>
			(await db.select().from(tasks)).map((t) => [t.id, t.priority, t.updatedAt]);
		await db.update(tasks).set({ deletedAt: 1 }).where(eq(tasks.id, ids[4]!));
		const before = await snapshot();
		const gone = await run(
			issuesPage.actions.bulk,
			req(w.member, '/issues?/bulk', {
				form: [...ids.map((id) => ['taskId', id] as [string, string]), ['priority', 'high']]
			})
		);
		expect(status(gone)).toBe(404);
		expect(pm(gone).message).toBe('Some tasks no longer exist, reload.');
		expect(await snapshot()).toEqual(before);
		await db.update(tasks).set({ deletedAt: null }).where(eq(tasks.id, ids[4]!));
		await archive(db, ps[2]!.id);
		const frozen = await run(
			issuesPage.actions.bulk,
			req(w.member, '/issues?/bulk', {
				form: [...ids.map((id) => ['taskId', id] as [string, string]), ['priority', 'high']]
			})
		);
		expect(status(frozen)).toBe(409);
		expect(pm(frozen).message).toBe('Some selected tasks are in archived projects.');
		expect((await snapshot()).every(([, p]) => p !== 'high')).toBe(true);
	});

	it('assign notifies only changed tasks, never self; label cap skips are reported; milestone and project labels are refused', async () => {
		const w = await world();
		const a = await seedTask(db, w.admin, w.ops, { assigneeId: w.other.id });
		const b = await seedTask(db, w.admin, w.web);
		const self = await issuesBulkUpdate(db, w.member, [a.id, b.id], { assigneeId: w.member.id }, 1);
		expect(self.ok).toBe(true);
		expect(
			await db.select().from(notifications).where(eq(notifications.userId, w.member.id))
		).toHaveLength(0);
		await issuesBulkUpdate(db, w.admin, [a.id, b.id], { assigneeId: w.other.id }, 2);
		expect(
			await db.select().from(notifications).where(eq(notifications.userId, w.other.id))
		).toHaveLength(2);
		const full: string[] = [];
		for (let i = 0; i < 10; i++) full.push(await teamLabel(w.admin, `f${i}`));
		await setTaskLabels(db, w.ops.id, a.id, { labelIds: [], teamLabelIds: full }, 1);
		const extra = await teamLabel(w.admin, 'Extra');
		const capped = await run(
			issuesPage.actions.bulk,
			req(w.member, '/issues?/bulk', {
				form: [
					['taskId', a.id],
					['taskId', b.id],
					['addTeamLabelId', extra]
				]
			})
		);
		expect(pm(capped)).toMatchObject({ ok: true });
		expect(pm(capped).message).toMatch(/1 already had 10 labels/);
		const milestone = await run(
			issuesPage.actions.bulk,
			req(w.member, '/issues?/bulk', {
				form: [
					['taskId', a.id],
					['milestoneId', NONE]
				]
			})
		);
		expect(status(milestone)).toBe(400);
		expect(
			status(
				await run(issuesPage.actions.bulk, req(null, '/issues?/bulk', { form: { taskId: a.id } }))
			)
		).toBe(401);
	});
});

describe('bulk throttle (red team L3)', () => {
	it('30 bulk requests per user per 10 minutes, project list and Issues together; the 31st is 429 and writes nothing', async () => {
		pinToWindowStart(THROTTLE_WINDOW_MS);
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		const form = (priority: string): [string, string][] => [
			['taskId', t.id],
			['priority', priority]
		];
		for (let i = 0; i < 15; i++) {
			expect(
				pm(
					await run(issuesPage.actions.bulk, req(w.member, '/issues?/bulk', { form: form('low') }))
				).ok
			).toBe(true);
			expect(
				pm(
					await run(
						projectPage.actions.bulk,
						req(w.member, '/projects/OPS?/bulk', { params: { key: 'OPS' }, form: form('low') })
					)
				).ok
			).toBe(true);
		}
		for (const over of [
			await run(issuesPage.actions.bulk, req(w.member, '/issues?/bulk', { form: form('urgent') })),
			await run(
				projectPage.actions.bulk,
				req(w.member, '/projects/OPS?/bulk', { params: { key: 'OPS' }, form: form('urgent') })
			)
		]) {
			expect(status(over)).toBe(429);
			expect(pm(over)).toMatchObject({ ok: false, message: PM_MESSAGES.bulkThrottled });
		}
		expect((await taskRow(db, t.id))!.priority).toBe('low');
		// Another user has a budget of their own.
		expect(
			pm(await run(issuesPage.actions.bulk, req(w.other, '/issues?/bulk', { form: form('high') })))
				.ok
		).toBe(true);
		expect(PM_LIMITS.bulkPerWindow).toBe(30);
	});
});

describe('project bulk (RB-08 bar)', () => {
	it("sets the type and adds a team label inside one project; another project's task fails the request", async () => {
		const w = await world();
		const team = await teamLabel(w.admin, 'Customer');
		const a = await seedTask(db, w.member, w.ops);
		const b = await seedTask(db, w.member, w.ops);
		const elsewhere = await seedTask(db, w.member, w.web);
		const ok = await run(
			projectPage.actions.bulk,
			req(w.member, '/projects/OPS?/bulk', {
				params: { key: 'OPS' },
				form: [
					['taskId', a.id],
					['taskId', b.id],
					['type', 'improvement'],
					['addTeamLabelId', team]
				]
			})
		);
		expect(pm(ok)).toMatchObject({ ok: true, message: '2 tasks updated.' });
		expect((await taskRow(db, a.id))!.type).toBe('improvement');
		const links = await d1
			.prepare('SELECT count(*) AS n FROM task_team_labels')
			.first<{ n: number }>();
		expect(links!.n).toBe(2);
		const mixed = await run(
			projectPage.actions.bulk,
			req(w.member, '/projects/OPS?/bulk', {
				params: { key: 'OPS' },
				form: [
					['taskId', a.id],
					['taskId', elsewhere.id],
					['type', 'bug']
				]
			})
		);
		expect(status(mixed)).toBe(404);
		expect((await taskRow(db, a.id))!.type).toBe('improvement');
	});
});

// ── Report an issue ─────────────────────────────────────────────────────────────────────────────────────────

describe('Report an issue', () => {
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
	const count = async () =>
		(await d1.prepare('SELECT count(*) AS n FROM tasks').first<{ n: number }>())!.n;

	it('files a Bug as a normal task: fresh number, reporter, backlog, labels, raw Markdown', async () => {
		const w = await world();
		const team = await teamLabel(w.admin, 'Customer');
		const own = await projectLabel(w.ops.id, w.admin, 'Lights');
		const body = '<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))';
		const r = await report(
			w.member,
			reportForm({ priority: 'high', description: body }, [
				['labelId', own],
				['teamLabelId', team]
			])
		);
		expect(isRedirect(r)).toBe(true);
		expect((r as { location: string }).location).toBe('/projects/OPS/tasks/1?reported=2-2');
		const t = (await db.select().from(tasks))[0]!;
		expect(t).toMatchObject({
			number: 1,
			createdBy: w.member.id,
			type: 'bug',
			status: 'backlog',
			priority: 'high',
			description: body
		});
		const html = renderMarkdown(t.description);
		expect(html).not.toMatch(/<script|<img|href="javascript:/i);
		expect(html).toContain('&lt;script&gt;');
		expect((await list(w.member)).rows[0]!.labels.map((l) => l.scope).sort()).toEqual([
			'project',
			'team'
		]);
	});

	it('archived or deleted project: refused (409 / 404), nothing inserted; the picker lists active projects only', async () => {
		const w = await world();
		await archive(db, w.web.id);
		expect(status(await report(w.member, reportForm({ projectKey: 'WEB' })))).toBe(409);
		expect(status(await report(w.member, reportForm({ projectKey: 'NOPE' })))).toBe(404);
		expect(await count()).toBe(0);
		const page = dataOf<{ projects: { key: string }[]; type: string }>(
			await run(reportPage.load, req(w.member, '/issues/new'))
		);
		expect(page.projects.map((p) => p.key)).toEqual(['OPS']);
		expect(page.type).toBe('bug');
	});

	it('field errors with nothing inserted; boundary values accepted', async () => {
		const w = await world();
		const foreign = await projectLabel(w.web.id, w.admin, 'Elsewhere');
		const many = Array.from(
			{ length: 11 },
			() => ['teamLabelId', crypto.randomUUID()] as [string, string]
		);
		for (const form of [
			reportForm({ title: '' }),
			reportForm({ title: 'x'.repeat(201) }),
			reportForm({ description: 'x'.repeat(20_001) }),
			reportForm({ type: 'epic' }),
			reportForm({ priority: 'extreme' }),
			reportForm({}, many),
			reportForm({}, [['labelId', foreign]]),
			reportForm({ submissionId: 'not-an-id' })
		])
			expect(status(await report(w.member, form))).toBe(400);
		expect(await count()).toBe(0);
		const ok = await report(
			w.member,
			reportForm({ title: 'x'.repeat(200), description: 'y'.repeat(20_000) })
		);
		expect(isRedirect(ok)).toBe(true);
		expect(await count()).toBe(1);
	});

	it('the same submission twice (and 10 at once) makes one task; a foreign id is refused', async () => {
		const w = await world();
		const id = crypto.randomUUID();
		const first = await report(w.member, reportForm({ submissionId: id }));
		const second = await report(w.member, reportForm({ submissionId: id, title: 'Again' }));
		expect((first as { location: string }).location).toMatch(/\/projects\/OPS\/tasks\/1\?/);
		expect((second as { location: string }).location).toMatch(/\/projects\/OPS\/tasks\/1\?/);
		const raced = crypto.randomUUID();
		const results = await Promise.all(
			Array.from({ length: 10 }, () => report(w.member, reportForm({ submissionId: raced })))
		);
		expect(results.every((r) => isRedirect(r))).toBe(true);
		expect(new Set(results.map((r) => (r as { location: string }).location)).size).toBe(1);
		expect(await count()).toBe(2);
		expect(status(await report(w.other, reportForm({ submissionId: id })))).toBe(400);
		expect(await count()).toBe(2);
	});

	it('10 concurrent reports in one project get numbers 1..10; the 21st report in a minute is 429', async () => {
		// The 21 reports share one budget window.
		pinToWindowStart(THROTTLE_MINUTE_MS);
		await reportBurst();
	});

	async function reportBurst() {
		const w = await world();
		const done = await Promise.all(
			Array.from({ length: 10 }, (_, i) => report(w.member, reportForm({ title: `r${i}` })))
		);
		expect(done.every((r) => isRedirect(r))).toBe(true);
		const numbers = (await db.select({ n: tasks.number }).from(tasks))
			.map((r) => r.n)
			.sort((a, b) => a - b);
		expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		for (let i = 0; i < 10; i++) await report(w.member, reportForm({ title: `s${i}` }));
		const over = await report(w.member, reportForm({ title: 'one too many' }));
		expect(status(over)).toBe(429);
		expect(await count()).toBe(20);
	}

	it('a label deleted between load and submit is skipped and reported, never half-applied', async () => {
		const w = await world();
		const keep = await teamLabel(w.admin, 'Keep');
		const drop = await teamLabel(w.admin, 'Drop');
		await deleteTeamLabel(db, w.admin, drop, Date.now());
		const r = await report(
			w.member,
			reportForm({}, [
				['teamLabelId', keep],
				['teamLabelId', drop]
			])
		);
		expect((r as { location: string }).location).toBe('/projects/OPS/tasks/1?reported=1-2');
		const page = dataOf<{ reported: { skipped: number } | null }>(
			await run(
				taskPage.load,
				req(w.member, '/projects/OPS/tasks/1?reported=1-2', { params: { key: 'OPS', number: '1' } })
			)
		);
		expect(page.reported).toEqual({ skipped: 1 });
	});

	it('the load picks ?project=, else the last project reported into; labels endpoint and budgets', async () => {
		const w = await world();
		const own = await projectLabel(w.web.id, w.admin, 'Mobile');
		await seedTask(db, w.member, w.web);
		const counted = async (path: string) => {
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
			const r = dataOf<{ projectKey: string | null; projectLabels: { id: string }[] }>(
				await run(reportPage.load, req(w.member, path, { database: getDb(proxy) }))
			);
			return { r, n };
		};
		const last = await counted('/issues/new');
		expect(last.r.projectKey).toBe('WEB');
		expect(last.r.projectLabels.map((l) => l.id)).toEqual([own]);
		expect(last.n).toBeLessThanOrEqual(5);
		expect((await counted('/issues/new?project=ops')).r.projectKey).toBe('OPS');
		await archive(db, w.ops.id);
		expect((await counted('/issues/new?project=OPS')).r.projectKey).toBe('WEB');
		const api = async (q: string, user: SessionUser | null = w.member) => {
			const r = await run(labelsApi.GET, req(user, `/issues/labels${q}`));
			return r instanceof Response ? ((await r.json()) as { labels: { id: string }[] }) : r;
		};
		expect(await api('?project=WEB')).toEqual({ labels: [expect.objectContaining({ id: own })] });
		expect(await api('?project=OPS')).toEqual({ labels: [] });
		expect(await api('?project=%27;drop')).toEqual({ labels: [] });
		expect(status(await api('?project=WEB', null))).toBe(401);
		expect(status(await run(reportPage.load, req(null, '/issues/new')))).toBe(401);
		expect(status(await report(null, reportForm({})))).toBe(401);
	});
});

// ── Saved Issues views ──────────────────────────────────────────────────────────────────────────────────────

describe('Issues saved views', () => {
	it('saves only whitelisted keys from the URL, opens them, caps at 20, refuses duplicates', async () => {
		const w = await world();
		const save = (name: string, query: string, user = w.member) =>
			run(issuesPage.actions.saveView, req(user, `/issues?${query}&/saveView`, { form: { name } }));
		const ok = await save('Open bugs', 'type=bug&x=<script>&sort=;drop&page=4&project=ops');
		expect(pm(ok).ok).toBe(true);
		const stored = await db
			.select()
			.from(savedViews)
			.where(eq(savedViews.id, pm(ok).id!))
			.get();
		expect(stored).toMatchObject({
			kind: 'issues',
			projectId: null,
			query: 'type=bug&project=OPS'
		});
		const opened = await run(
			openIssueView.GET,
			req(w.member, `/issues/views/${stored!.id}`, { params: { id: stored!.id } })
		);
		expect((opened as { location: string }).location).toBe('/issues?type=bug&project=OPS');
		expect(status(await save('Open bugs', 'type=task'))).toBe(400);
		for (let i = 1; i < 20; i++) expect(pm(await save(`v${i}`, '')).ok).toBe(true);
		const over = await save('twenty-first', '');
		expect(status(over)).toBe(400);
		expect(pm(over).message).toMatch(/20 issue views/);
		// Project views have their own scope and cap.
		expect(
			(await saveView(db, w.member.id, w.ops.id, { name: 'Open bugs', kind: 'list', query: '' }, 1))
				.ok
		).toBe(true);
	});

	it('scopes: another user, a project view on /issues, an Issues view on a project all 404', async () => {
		const w = await world();
		const mine = await saveView(
			db,
			w.member.id,
			null,
			{ name: 'Mine', kind: 'issues', query: '' },
			1
		);
		const project = await saveView(
			db,
			w.member.id,
			w.ops.id,
			{ name: 'P', kind: 'list', query: '' },
			1
		);
		if (!mine.ok || !project.ok) throw new Error('views');
		const open = (user: SessionUser, id: string) =>
			run(openIssueView.GET, req(user, `/issues/views/${id}`, { params: { id } }));
		expect(status(await open(w.other, mine.id))).toBe(404);
		expect(status(await open(w.member, project.id))).toBe(404);
		expect(status(await open(w.member, 'nope'))).toBe(404);
		expect(
			status(
				await run(
					openProjectView.GET,
					req(w.member, `/projects/OPS/views/${mine.id}`, { params: { key: 'OPS', id: mine.id } })
				)
			)
		).toBe(404);
		expect(
			status(
				await run(
					issuesPage.actions.deleteView,
					req(w.other, '/issues?/deleteView', { form: { id: mine.id } })
				)
			)
		).toBe(404);
		expect(
			pm(
				await run(
					issuesPage.actions.deleteView,
					req(w.member, '/issues?/deleteView', { form: { id: mine.id } })
				)
			).ok
		).toBe(true);
		// The kind must match the scope.
		expect(
			await saveView(db, w.member.id, null, { name: 'Bad', kind: 'list', query: '' }, 1)
		).toMatchObject({ ok: false });
	});

	it('a view naming a deleted project still opens; the page says the filter no longer applies', async () => {
		const w = await world();
		const v = await saveView(
			db,
			w.member.id,
			null,
			{ name: 'Web', kind: 'issues', query: 'project=WEB' },
			1
		);
		if (!v.ok) throw new Error('view');
		await db.update(projects).set({ deletedAt: 1 }).where(eq(projects.id, w.web.id));
		const opened = await run(
			openIssueView.GET,
			req(w.member, `/issues/views/${v.id}`, { params: { id: v.id } })
		);
		expect((opened as { location: string }).location).toBe('/issues?project=WEB');
		const page = dataOf<{ stale: number }>(
			await run(issuesPage.load, req(w.member, '/issues?project=WEB'))
		);
		expect(page.stale).toBe(1);
	});
});

// ── Logging ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('privacy', () => {
	it('report, bulk and label writes log no titles, descriptions or label names', async () => {
		const w = await world();
		const spies = [
			vi.spyOn(console, 'log'),
			vi.spyOn(console, 'info'),
			vi.spyOn(console, 'warn'),
			vi.spyOn(console, 'error')
		];
		try {
			const team = await teamLabel(w.admin, 'Fictional-secret-label');
			await run(
				reportPage.actions.default,
				req(w.member, '/issues/new', {
					form: {
						projectKey: 'OPS',
						type: 'bug',
						title: 'Fictional-secret-title',
						description: 'Fictional-secret-body',
						priority: 'none',
						submissionId: crypto.randomUUID(),
						teamLabelId: team
					}
				})
			);
			const t = (await db.select().from(tasks))[0]!;
			await issuesBulkUpdate(db, w.member, [t.id], { removeTeamLabelId: team }, 1);
			const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
			for (const secret of [
				'Fictional-secret-label',
				'Fictional-secret-title',
				'Fictional-secret-body'
			])
				expect(logged).not.toContain(secret);
		} finally {
			for (const s of spies) s.mockRestore();
		}
		expect(await db.select().from(users)).toHaveLength(3);
	});
});

// ── Rendering ───────────────────────────────────────────────────────────────────────────────────────────────

describe('chips and badges', () => {
	it('label names render as plain text; team chips carry a marker; the quiet type badge hides Task', async () => {
		const { render } = await import('svelte/server');
		const LabelChip = (await import('../../src/lib/ui/pm/LabelChip.svelte')).default;
		const TypeBadge = (await import('../../src/lib/ui/issues/TypeBadge.svelte')).default;
		const team = render(LabelChip, {
			props: { name: '<img src=x onerror=alert(1)>', color: 'red', scope: 'team' }
		}).body;
		expect(team).toContain('Team label:');
		expect(team).toContain('&lt;img');
		expect(team).not.toContain('<img');
		expect(render(LabelChip, { props: { name: 'Bug', color: 'red' } }).body).not.toContain(
			'Team label'
		);
		expect(render(TypeBadge, { props: { type: 'task', quiet: true } }).body).not.toContain('Task');
		const bug = render(TypeBadge, { props: { type: 'bug', quiet: true } }).body;
		expect(bug).toContain('Bug');
		expect(bug).toContain('<svg');
	});
});
