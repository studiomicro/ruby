import { isHttpError, isRedirect } from '@sveltejs/kit';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { render } from 'svelte/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { sessionCookieName } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import {
	labels,
	milestones,
	notifications,
	projectColumns,
	projects,
	savedViews,
	taskChecklistItems,
	taskLabels,
	tasks
} from '#lib/server/db/schema';
import { bulkUpdate } from '#lib/server/pm/bulk';
import { addItem } from '#lib/server/pm/checklist';
import { getColumns } from '#lib/server/pm/columns';
import { taskExtras } from '#lib/server/pm/extras';
import { createLabel, deleteLabel, setTaskLabels } from '#lib/server/pm/labels';
import { createMilestone, deleteMilestone, getMilestone } from '#lib/server/pm/milestones';
import { canonicalizeQuery } from '#lib/server/pm/query';
import { labelNameKey } from '#lib/server/pm/validation';
import { listTasks } from '#lib/server/tasks/repo';
import { parseFilters, parseSort } from '#lib/server/tasks/validation';
import LabelChip from '../../src/lib/ui/pm/LabelChip.svelte';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { clearAll, seedProject, seedTask, taskRow } from '../helpers/seed-tasks';
import { insertSession, insertUser } from '../helpers/users';

/**
 * Red-team probes for RB-08 project management plus against a fresh local D1
 * (docs/features/rb-08-project-management-plus/SECURITY_REPORT.md). Tests named `PROOF` document a finding (they
 * assert the weak behaviour as it ships); every other test asserts a defence that holds. Fictional data only.
 */

const binding: {
	DB?: D1Database;
	TEAM_TIME_ZONE: string;
	ACCESS_TEAM_DOMAIN: string;
	ACCESS_AUD: string;
} = { TEAM_TIME_ZONE: 'UTC', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' };
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const { handle } = await import('../../src/hooks.server');
const layout = await import('../../src/routes/(app)/projects/[key]/+layout.server');
const view = await import('../../src/routes/(app)/projects/[key]/+page.server');
const settings = await import('../../src/routes/(app)/projects/[key]/settings/+page.server');
const detail = await import('../../src/routes/(app)/projects/[key]/tasks/[number]/+page.server');
const milestonePage =
	await import('../../src/routes/(app)/projects/[key]/milestones/[id]/+page.server');
const openView = await import('../../src/routes/(app)/projects/[key]/views/[id]/+server');

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
	};

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
		parent: async () => (await layout.load(event as never)) as Record<string, unknown>
	});
	return event;
}

async function world() {
	const admin = await insertUser(db, { role: 'admin', name: 'Ada Admin' });
	const lead = await insertUser(db, { name: 'Lee Lead' });
	const member = await insertUser(db, { name: 'Mo Member' });
	const target = await insertUser(db, { name: 'Tia Target' });
	const disabled = await insertUser(db, { name: 'Dee Disabled', status: 'disabled' });
	const ops = await seedProject(db, admin, { key: 'OPS', leadId: lead.id });
	const fin = await seedProject(db, admin, { key: 'FIN', leadId: lead.id });
	return { admin, lead, member, target, disabled, ops, fin };
}

const mkLabel = async (projectId: string, actor: SessionUser, name: string) => {
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
const mkMilestone = async (projectId: string, actor: SessionUser, name = 'Beta') => {
	const r = await createMilestone(
		db,
		actor,
		projectId,
		{ name, description: '', dueOn: null },
		Date.now()
	);
	if (!r.ok) throw new Error(`milestone: ${r.reason}`);
	return r.id;
};
const seedMany = async (actor: SessionUser, project: { id: string }, n: number) => {
	const out: { id: string; number: number }[] = [];
	for (let i = 0; i < n; i += 1) out.push(await seedTask(db, actor, project, { title: `T${i}` }));
	return out;
};
const unreadAssigned = async (userId: string) =>
	(
		await db
			.select()
			.from(notifications)
			.where(
				and(
					eq(notifications.userId, userId),
					eq(notifications.kind, 'assigned'),
					isNull(notifications.readAt)
				)
			)
	).length;

// ── Hooks: deactivated sessions, CSRF, cache headers ───────────────────────────────────────────────────────

describe('pipeline: deactivated users, CSRF and caching on the new actions', () => {
	const posts: [string, string, Record<string, string>][] = [
		[
			'/projects/OPS?/bulk',
			'/(app)/projects/[key]',
			{ taskId: crypto.randomUUID(), status: 'done' }
		],
		['/projects/OPS?/viewSave', '/(app)/projects/[key]', { name: 'x', query: 'status=todo' }],
		[
			'/projects/OPS/settings?/labelSave',
			'/(app)/projects/[key]/settings',
			{ name: 'Bug', color: 'red' }
		],
		[
			'/projects/OPS/settings?/columnsSave',
			'/(app)/projects/[key]/settings',
			{ expectedUpdatedAt: '0' }
		],
		['/projects/OPS/tasks/1?/checkAdd', '/(app)/projects/[key]/tasks/[number]', { text: 'step' }],
		[
			'/projects/OPS/tasks/1?/labelsSet',
			'/(app)/projects/[key]/tasks/[number]',
			{ labelId: crypto.randomUUID() }
		]
	];

	it('a deactivated user’s live session is dropped before any RB-08 action runs', async () => {
		const w = await world();
		await seedTask(db, w.admin, w.ops);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		for (const [path, routeId, form] of posts) {
			const token = await insertSession(db, w.disabled.id);
			const resolve = vi.fn(async () => new Response('ran'));
			const { event } = fakeEvent({
				url: `http://localhost${path}`,
				routeId,
				db,
				cookies: { [sessionCookieName(false)]: token },
				form
			});
			const response = await handle({ event, resolve } as never);
			expect(event.locals.user, path).toBeNull();
			expect(resolve, path).not.toHaveBeenCalled();
			expect([302, 303, 401], path).toContain(response.status);
			expect(response.headers.get('cache-control'), path).toContain('no-store');
		}
	});

	it('CSRF: cross-site and Origin-less POSTs to every RB-08 action are refused before routing', async () => {
		const w = await world();
		await seedTask(db, w.admin, w.ops);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		for (const [path, routeId, form] of posts)
			for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }]) {
				const token = await insertSession(db, w.member.id);
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
		expect(await db.select().from(labels)).toHaveLength(0);
		expect(await db.select().from(taskChecklistItems)).toHaveLength(0);
	});

	it('the saved-view GET answers private, no-store for a signed-in user (hook) and changes no state', async () => {
		const w = await world();
		const token = await insertSession(db, w.member.id);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const { event } = fakeEvent({
			url: `http://localhost/projects/OPS/views/${crypto.randomUUID()}`,
			routeId: '/(app)/projects/[key]/views/[id]',
			db,
			cookies: { [sessionCookieName(false)]: token }
		});
		const response = await handle({
			event,
			resolve: async () =>
				new Response(null, { status: 303, headers: { location: '/projects/OPS' } })
		} as never);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
	});
});

// ── IDOR with cross-project ids ─────────────────────────────────────────────────────────────────────────────

describe('IDOR: ids of another project are never accepted', () => {
	it('labelsSet with a FIN label on an OPS task: refused, nothing linked', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		const own = await mkLabel(w.ops.id, w.member, 'Own');
		const foreign = await mkLabel(w.fin.id, w.member, 'Foreign');
		const r = await run(
			detail.actions.labelsSet,
			req(w.member, '/projects/OPS/tasks/1', {
				params: { key: 'OPS', number: String(t.number) },
				form: [
					['labelId', own],
					['labelId', foreign]
				]
			})
		);
		expect(status(r)).toBe(400);
		expect(await db.select().from(taskLabels)).toHaveLength(0);
	});

	it('patch milestoneId to another project’s open milestone: refused, task unchanged', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		const foreign = await mkMilestone(w.fin.id, w.admin);
		const before = await taskRow(db, t.id);
		const r = await run(
			detail.actions.patch,
			req(w.member, '/projects/OPS/tasks/1', {
				params: { key: 'OPS', number: String(t.number) },
				form: {
					field: 'milestoneId',
					value: foreign,
					expectedUpdatedAt: String(before!.updatedAt)
				}
			})
		);
		expect(status(r)).toBe(400);
		expect(await taskRow(db, t.id)).toEqual(before);
	});

	it('bulk: a FIN milestone, a FIN label to add, a FIN task id: each refused with nothing written', async () => {
		const w = await world();
		const mine = await seedMany(w.member, w.ops, 3);
		const theirs = await seedTask(db, w.member, w.fin);
		const finMilestone = await mkMilestone(w.fin.id, w.admin);
		const finLabel = await mkLabel(w.fin.id, w.member, 'Foreign');
		const snapshot = async () => db.select().from(tasks).orderBy(tasks.id);
		const before = await snapshot();
		const attempts: [string, string][][] = [
			[...mine.map((t) => ['taskId', t.id] as [string, string]), ['milestoneId', finMilestone]],
			[...mine.map((t) => ['taskId', t.id] as [string, string]), ['addLabelId', finLabel]],
			[
				...mine.map((t) => ['taskId', t.id] as [string, string]),
				['taskId', theirs.id],
				['status', 'done'],
				['assigneeId', w.target.id]
			]
		];
		for (const form of attempts) {
			const r = await run(
				view.actions.bulk,
				req(w.member, '/projects/OPS', { params: { key: 'OPS' }, form })
			);
			expect([400, 404]).toContain(status(r));
		}
		expect(await snapshot()).toEqual(before);
		expect(await db.select().from(taskLabels)).toHaveLength(0);
		expect(await unreadAssigned(w.target.id)).toBe(0);
	});

	it('checklist step of a FIN task addressed through an OPS task URL: 404 answer, step untouched', async () => {
		const w = await world();
		const opsTask = await seedTask(db, w.member, w.ops);
		const finTask = await seedTask(db, w.member, w.fin);
		const step = await addItem(db, w.member, w.fin.id, finTask.id, 'Secret step', Date.now());
		if (!step.ok) throw new Error('seed');
		for (const action of ['checkToggle', 'checkDelete', 'checkMove', 'checkEdit'] as const) {
			const r = await run(
				detail.actions[action],
				req(w.member, '/projects/OPS/tasks/1', {
					params: { key: 'OPS', number: String(opsTask.number) },
					form: { id: step.id, done: '1', direction: 'up', text: 'pwned', expectedUpdatedAt: '1' }
				})
			);
			expect(status(r), action).toBe(404);
		}
		const row = await db
			.select()
			.from(taskChecklistItems)
			.where(eq(taskChecklistItems.id, step.id))
			.get();
		expect(row).toMatchObject({ text: 'Secret step', done: 0, deletedAt: null });
	});

	it('a lead of both projects cannot rename, delete or close FIN rows through the OPS settings URL', async () => {
		const w = await world();
		const finLabel = await mkLabel(w.fin.id, w.member, 'Foreign');
		const finMilestone = await mkMilestone(w.fin.id, w.admin);
		const finTask = await seedTask(db, w.member, w.fin, { milestoneId: finMilestone });
		const labelBefore = await db.select().from(labels).where(eq(labels.id, finLabel)).get();
		const msBefore = await db
			.select()
			.from(milestones)
			.where(eq(milestones.id, finMilestone))
			.get();
		const calls: [unknown, Record<string, string>][] = [
			[
				settings.actions.labelSave,
				{
					id: finLabel,
					name: 'Pwned',
					color: 'blue',
					expectedUpdatedAt: String(labelBefore!.updatedAt)
				}
			],
			[settings.actions.labelDelete, { id: finLabel }],
			[
				settings.actions.milestoneSave,
				{ id: finMilestone, name: 'Pwned', expectedUpdatedAt: String(msBefore!.updatedAt) }
			],
			[
				settings.actions.milestoneStatus,
				{ id: finMilestone, status: 'closed', expectedUpdatedAt: String(msBefore!.updatedAt) }
			],
			[settings.actions.milestoneDelete, { id: finMilestone }]
		];
		for (const [fn, form] of calls) {
			const r = await run(
				fn,
				req(w.lead, '/projects/OPS/settings', { params: { key: 'OPS' }, form })
			);
			expect(status(r)).toBe(404);
		}
		expect(await db.select().from(labels).where(eq(labels.id, finLabel)).get()).toEqual(
			labelBefore
		);
		expect(await db.select().from(milestones).where(eq(milestones.id, finMilestone)).get()).toEqual(
			msBefore
		);
		expect((await taskRow(db, finTask.id))?.milestoneId).toBe(finMilestone);
	});

	it('saved views: another user’s id is 404 on open and delete (same answer as a random id); own view opens same-origin', async () => {
		const w = await world();
		const saved = await run(
			view.actions.viewSave,
			req(w.member, '/projects/OPS', {
				params: { key: 'OPS' },
				form: { name: 'Mine', kind: 'list', query: 'status=todo' }
			})
		);
		expect(pm(saved).ok).toBe(true);
		const id = (await db.select().from(savedViews).get())!.id;
		const theirs = await run(
			openView.GET,
			req(w.target, `/projects/OPS/views/${id}`, { params: { key: 'OPS', id } })
		);
		const random = crypto.randomUUID();
		const missing = await run(
			openView.GET,
			req(w.target, `/projects/OPS/views/${random}`, { params: { key: 'OPS', id: random } })
		);
		expect(status(theirs)).toBe(404);
		expect((theirs as { body: unknown }).body).toEqual((missing as { body: unknown }).body);
		// Through the other project's URL the owner gets 404 too.
		const viaFin = await run(
			openView.GET,
			req(w.member, `/projects/FIN/views/${id}`, { params: { key: 'FIN', id } })
		);
		expect(status(viaFin)).toBe(404);
		const del = await run(
			view.actions.viewDelete,
			req(w.target, '/projects/OPS', { params: { key: 'OPS' }, form: { id } })
		);
		expect(status(del)).toBe(404);
		expect((await db.select().from(savedViews).get())?.deletedAt).toBeNull();
		const own = await run(
			openView.GET,
			req(w.member, `/projects/OPS/views/${id}`, { params: { key: 'OPS', id } })
		);
		expect(status(own)).toBe(303);
		expect((own as { location: string }).location).toBe('/projects/OPS?status=todo');
	});
});

// ── Saved-view query injection ──────────────────────────────────────────────────────────────────────────────

describe('saved-view query: only canonical, whitelisted values are stored or redirected to', () => {
	const uuid = '3f2b8c1e-5a4d-4e7f-9b0a-1c2d3e4f5a6b';
	it('canonicalizeQuery drops hostile keys and values (SQL, JSON, redirect, prototype, CRLF)', () => {
		const raw = new URLSearchParams();
		for (const [k, v] of [
			['x', '<script>alert(1)</script>'],
			['sort', 'number;drop table tasks'],
			['sort', 'number'],
			['dir', 'desc) --'],
			['label', `${uuid}"]`],
			['label', `["${uuid}"]`],
			['label', "' or 1=1 --"],
			['label', uuid.toUpperCase()],
			['label', uuid],
			['milestone', "none' --"],
			['assignee', '//evil.example'],
			['status', 'todo'],
			['status', 'todo'],
			['status', 'done\r\nSet-Cookie: x=1'],
			['__proto__', 'polluted'],
			['view', 'board'],
			['redirect', 'https://evil.example']
		])
			raw.append(k!, v!);
		// `sort` keeps only the first value, which is hostile here, so no sort survives.
		expect(canonicalizeQuery('list', raw)).toBe(`status=todo&label=${uuid}`);
		expect(canonicalizeQuery('board', raw)).toBe(`view=board&status=todo&label=${uuid}`);
		// The length cap: 500 characters of canonical output, else null (nothing stored).
		const many = new URLSearchParams();
		for (let i = 0; i < 20; i += 1) many.append('label', crypto.randomUUID());
		expect(canonicalizeQuery('list', many)).toBeNull();
	});

	it('viewSave through the route stores only the canonical query; the open redirect stays on /projects/<key>', async () => {
		const w = await world();
		const r = await run(
			view.actions.viewSave,
			req(w.member, '/projects/OPS', {
				params: { key: 'OPS' },
				form: {
					name: '<img src=x onerror=alert(1)>',
					kind: 'list',
					query: '//evil.example/?status=todo&sort=;drop&x=<script>&label=1 or 1=1'
				}
			})
		);
		expect(pm(r).ok).toBe(true);
		const row = (await db.select().from(savedViews).get())!;
		expect(row.query).toBe('');
		expect(row.name).toBe('<img src=x onerror=alert(1)>');
		const open = await run(
			openView.GET,
			req(w.member, `/projects/OPS/views/${row.id}`, { params: { key: 'OPS', id: row.id } })
		);
		expect((open as { location: string }).location).toBe('/projects/OPS');
	});

	it('listTasks with 30 label ids and hostile sort params runs as bound JSON (no SQL error, no leak)', async () => {
		const w = await world();
		await seedMany(w.member, w.ops, 3);
		const p = new URLSearchParams();
		for (let i = 0; i < 40; i += 1) p.append('label', crypto.randomUUID());
		p.append('label', "') or 1=1 --");
		p.set('sort', 'number desc; drop table tasks');
		p.set('milestone', "' union select * from users --");
		const filters = parseFilters(p);
		expect(filters.labels).toHaveLength(30);
		expect(filters.milestone).toBe('any');
		const list = await listTasks(db, w.ops.id, filters, parseSort(p), 1, w.member.id);
		expect(list.rows).toHaveLength(0);
		expect(await db.select().from(tasks)).toHaveLength(3);
	});
});

// ── Bulk edit ───────────────────────────────────────────────────────────────────────────────────────────────

describe('bulk edit', () => {
	it('101 distinct ids refused before any SQL; 100 duplicates of one id count once', async () => {
		const w = await world();
		const ids: [string, string][] = Array.from({ length: 101 }, () => [
			'taskId',
			crypto.randomUUID()
		]);
		const r = await run(
			view.actions.bulk,
			req(w.member, '/projects/OPS', {
				params: { key: 'OPS' },
				form: [...ids, ['priority', 'high']]
			})
		);
		expect(status(r)).toBe(400);
		const t = await seedTask(db, w.member, w.ops);
		const dup: [string, string][] = Array.from({ length: 150 }, () => [
			'taskId',
			t.id.toUpperCase()
		]);
		const ok = await run(
			view.actions.bulk,
			req(w.member, '/projects/OPS', {
				params: { key: 'OPS' },
				form: [...dup, ['priority', 'high']]
			})
		);
		expect(pm(ok)).toMatchObject({ ok: true, message: '1 task updated.' });
		// More than 400 raw values is refused outright (bounded parsing).
		const flood: [string, string][] = Array.from({ length: 401 }, () => ['taskId', t.id]);
		const big = await run(
			view.actions.bulk,
			req(w.member, '/projects/OPS', {
				params: { key: 'OPS' },
				form: [...flood, ['priority', 'low']]
			})
		);
		expect(status(big)).toBe(400);
		expect((await taskRow(db, t.id))?.priority).toBe('high');
	});

	it('all or nothing: a task deleted mid-selection fails the whole request; archived project refused', async () => {
		const w = await world();
		const ts = await seedMany(w.member, w.ops, 5);
		await db.update(tasks).set({ deletedAt: Date.now() }).where(eq(tasks.id, ts[4]!.id));
		const before = await db.select().from(tasks).orderBy(tasks.id);
		const r = await bulkUpdate(
			db,
			w.member,
			w.ops.id,
			ts.map((t) => t.id),
			{ status: 'done', assigneeId: w.target.id },
			Date.now()
		);
		expect(r).toMatchObject({ ok: false, reason: 'not_found' });
		expect(await db.select().from(tasks).orderBy(tasks.id)).toEqual(before);
		expect(await unreadAssigned(w.target.id)).toBe(0);
		await db.update(projects).set({ status: 'archived' }).where(eq(projects.id, w.ops.id));
		const archived = await bulkUpdate(
			db,
			w.member,
			w.ops.id,
			ts.slice(0, 4).map((t) => t.id),
			{ priority: 'high' },
			Date.now()
		);
		expect(archived).toMatchObject({ ok: false, reason: 'archived' });
	});

	it('RB-01 dedupe holds through bulk: re-assigning, flipping away and back adds no unread duplicate; never to oneself', async () => {
		const w = await world();
		const ts = await seedMany(w.member, w.ops, 20);
		const ids = ts.map((t) => t.id);
		for (let i = 0; i < 3; i += 1) {
			expect(
				(await bulkUpdate(db, w.member, w.ops.id, ids, { assigneeId: w.target.id }, Date.now())).ok
			).toBe(true);
			expect(
				(await bulkUpdate(db, w.member, w.ops.id, ids, { assigneeId: w.lead.id }, Date.now())).ok
			).toBe(true);
		}
		expect(await unreadAssigned(w.target.id)).toBe(20);
		expect(await unreadAssigned(w.lead.id)).toBe(20);
		expect(
			(await bulkUpdate(db, w.member, w.ops.id, ids, { assigneeId: w.member.id }, Date.now())).ok
		).toBe(true);
		expect(await unreadAssigned(w.member.id)).toBe(0);
		// A deactivated assignee is refused with nothing written.
		const r = await bulkUpdate(
			db,
			w.member,
			w.ops.id,
			ids,
			{ assigneeId: w.disabled.id },
			Date.now()
		);
		expect(r.ok).toBe(false);
		expect(await unreadAssigned(w.disabled.id)).toBe(0);
	});

	it('FIXED L2 (was PROOF): one bulk request writes at most 10 notifications to one user, even after they are read', async () => {
		const w = await world();
		const ts = await seedMany(w.member, w.ops, 100);
		const ids = ts.map((t) => t.id);
		let total = 0;
		for (let round = 0; round < 3; round += 1) {
			const r = await bulkUpdate(
				db,
				w.member,
				w.ops.id,
				ids,
				{ assigneeId: w.target.id },
				Date.now()
			);
			// Every task is assigned; only the first 10 notify.
			expect(r).toMatchObject({ ok: true, updated: 100, notifySkipped: 90 });
			expect(
				(await db.select().from(tasks).where(eq(tasks.projectId, w.ops.id))).every(
					(t) => t.assigneeId === w.target.id
				)
			).toBe(true);
			total = (await db.select().from(notifications).where(eq(notifications.userId, w.target.id)))
				.length;
			// The victim reads everything; the attacker flips away and back.
			await db
				.update(notifications)
				.set({ readAt: Date.now() })
				.where(eq(notifications.userId, w.target.id));
			await bulkUpdate(db, w.member, w.ops.id, ids, { assigneeId: null }, Date.now());
		}
		expect(total).toBe(30);
	});

	it('label cap under concurrency: 20 concurrent bulk adds of different labels onto 9-label tasks: each ends at 10', async () => {
		const w = await world();
		const ts = await seedMany(w.member, w.ops, 5);
		const ids = ts.map((t) => t.id);
		const base: string[] = [];
		for (let i = 0; i < 9; i += 1) base.push(await mkLabel(w.ops.id, w.member, `Base ${i}`));
		for (const t of ts)
			expect((await setTaskLabels(db, w.ops.id, t.id, base, Date.now())).ok).toBe(true);
		const extra: string[] = [];
		for (let i = 0; i < 20; i += 1) extra.push(await mkLabel(w.ops.id, w.member, `Extra ${i}`));
		const results = await Promise.all(
			extra.map((l) => bulkUpdate(db, w.member, w.ops.id, ids, { addLabelId: l }, Date.now()))
		);
		expect(results.every((r) => r.ok)).toBe(true);
		const extras = await taskExtras(db, w.ops.id, ids);
		for (const t of ts) expect(extras.get(t.id)?.labels).toHaveLength(10);
	});

	it('hide vs. concurrent bulk move into the column: the column never ends hidden with tasks it did not hide over', async () => {
		const w = await world();
		const ts = await seedMany(w.member, w.ops, 10);
		for (let round = 0; round < 5; round += 1) {
			await db.delete(projectColumns);
			await db.update(tasks).set({ status: 'todo' });
			const version = (await getColumns(db, w.ops.id)).version;
			const form = { expectedUpdatedAt: String(version), hidden_in_review: 'on' };
			const [hide] = await Promise.all([
				run(
					settings.actions.columnsSave,
					req(w.lead, '/projects/OPS/settings', { params: { key: 'OPS' }, form })
				),
				bulkUpdate(
					db,
					w.member,
					w.ops.id,
					ts.map((t) => t.id),
					{ status: 'in_review' },
					Date.now()
				)
			]);
			const cols = await getColumns(db, w.ops.id);
			const col = cols.columns.find((c) => c.status === 'in_review')!;
			// Either the hide won (then the bulk move followed: tasks land in a hidden column, still counted for the
			// board note) or it was refused because the tasks were already there.
			if (col.hidden) expect(pm(hide).ok).toBe(true);
			else expect(pm(hide).ok).toBe(false);
			expect(col.taskCount).toBe(10);
		}
	});
});

// ── Count caps under concurrency (through the routes) ────────────────────────────────────────────────────

describe('caps under concurrency, through the routes', () => {
	it('30 labels, 50 steps, 20 views: 25 concurrent submissions against cap-5 each stop exactly at the cap', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		for (let i = 0; i < 25; i += 1) await mkLabel(w.ops.id, w.member, `L${i}`);
		for (let i = 0; i < 45; i += 1)
			await addItem(db, w.member, w.ops.id, t.id, `S${i}`, Date.now());
		for (let i = 0; i < 15; i += 1)
			await run(
				view.actions.viewSave,
				req(w.member, '/projects/OPS', {
					params: { key: 'OPS' },
					form: { name: `V${i}`, kind: 'list', query: '' }
				})
			);
		await Promise.all(
			Array.from({ length: 25 }, (_, i) => [
				run(
					settings.actions.labelSave,
					req(w.member, '/projects/OPS/settings', {
						params: { key: 'OPS' },
						form: { name: `C${i}`, color: 'blue' }
					})
				),
				run(
					detail.actions.checkAdd,
					req(w.member, '/projects/OPS/tasks/1', {
						params: { key: 'OPS', number: '1' },
						form: { text: `C${i}` }
					})
				),
				run(
					view.actions.viewSave,
					req(w.member, '/projects/OPS', {
						params: { key: 'OPS' },
						form: { name: `C${i}`, kind: 'list', query: '' }
					})
				)
			]).flat()
		);
		const liveLabels = await db
			.select()
			.from(labels)
			.where(and(eq(labels.projectId, w.ops.id), isNull(labels.deletedAt)));
		const liveSteps = await db
			.select()
			.from(taskChecklistItems)
			.where(isNull(taskChecklistItems.deletedAt));
		const liveViews = await db.select().from(savedViews).where(isNull(savedViews.deletedAt));
		expect(liveLabels).toHaveLength(30);
		expect(liveSteps).toHaveLength(50);
		expect(liveViews).toHaveLength(20);
	});
});

// ── Columns, labels: injection into markup ─────────────────────────────────────────────────────────────────

describe('markup and CSS injection', () => {
	it('label colour: the DB CHECK refuses a CSS payload even past the parser; the chip escapes the class attribute', async () => {
		const w = await world();
		await expect(
			db.insert(labels).values({
				id: crypto.randomUUID(),
				projectId: w.ops.id,
				name: 'x',
				nameKey: 'x',
				color: 'red;background:url(https://evil.example/x)' as 'red',
				createdBy: w.member.id,
				createdAt: 1,
				updatedAt: 1
			})
		).rejects.toThrow();
		const r = await run(
			settings.actions.labelSave,
			req(w.member, '/projects/OPS/settings', {
				params: { key: 'OPS' },
				form: { name: 'x', color: 'red" onmouseover="alert(1)' }
			})
		);
		expect(status(r)).toBe(400);
		const { body } = render(LabelChip, {
			props: { name: '<script>alert(1)</script>', color: 'red" onmouseover="alert(1)' as 'red' }
		});
		expect(body).not.toContain('<script>');
		// The quote is entity-encoded: the payload stays inside the class value.
		expect(body).toContain('red&quot; onmouseover=&quot;alert(1)');
		expect(body).not.toMatch(/onmouseover="/);
	});

	it('column names: control, bidi and zero-width characters stripped; 25 chars refused; stored as plain text', async () => {
		const w = await world();
		const ok = await run(
			settings.actions.columnsSave,
			req(w.lead, '/projects/OPS/settings', {
				params: { key: 'OPS' },
				form: { expectedUpdatedAt: '0', label_in_review: '<b>QA</b>‮​\u0007' }
			})
		);
		expect(pm(ok).ok).toBe(true);
		const col = (await getColumns(db, w.ops.id)).columns.find((c) => c.status === 'in_review')!;
		expect(col.label).toBe('<b>QA</b>');
		const long = await run(
			settings.actions.columnsSave,
			req(w.lead, '/projects/OPS/settings', {
				params: { key: 'OPS' },
				form: {
					expectedUpdatedAt: String((await getColumns(db, w.ops.id)).version),
					label_todo: 'x'.repeat(25)
				}
			})
		);
		expect(status(long)).toBe(400);
	});
});

// ── Soft-delete leaks ───────────────────────────────────────────────────────────────────────────────────────

describe('soft-deleted labels and milestones do not leak', () => {
	it('a deleted label leaves chips and filters and cannot be (re)applied through any path', async () => {
		const w = await world();
		const ts = await seedMany(w.member, w.ops, 2);
		const l = await mkLabel(w.ops.id, w.member, 'Gone');
		await setTaskLabels(db, w.ops.id, ts[0]!.id, [l], Date.now());
		expect((await deleteLabel(db, w.admin, w.ops.id, l, Date.now())).ok).toBe(true);
		expect((await taskExtras(db, w.ops.id, [ts[0]!.id])).get(ts[0]!.id)?.labels).toEqual([]);
		const loaded = (await run(
			view.load,
			req(w.member, `/projects/OPS?label=${l}`, { params: { key: 'OPS' } })
		)) as {
			filters: { labels: string[] };
			labels: { id: string }[];
		};
		expect(loaded.filters.labels).toEqual([]);
		expect(loaded.labels.map((x) => x.id)).not.toContain(l);
		expect((await setTaskLabels(db, w.ops.id, ts[1]!.id, [l], Date.now())).ok).toBe(false);
		expect(
			(await bulkUpdate(db, w.member, w.ops.id, [ts[1]!.id], { addLabelId: l }, Date.now())).ok
		).toBe(false);
		const direct = parseFilters(new URLSearchParams(`label=${l}`));
		expect(
			(await listTasks(db, w.ops.id, direct, parseSort(new URLSearchParams()), 1, w.member.id)).rows
		).toHaveLength(0);
	});

	it('a deleted milestone: page 404, filter dropped, tasks unlinked, cannot be assigned by patch or bulk', async () => {
		const w = await world();
		const m = await mkMilestone(w.ops.id, w.admin);
		const t = await seedTask(db, w.member, w.ops, { milestoneId: m });
		expect((await deleteMilestone(db, w.admin, w.ops.id, m, Date.now())).ok).toBe(true);
		expect(await getMilestone(db, w.ops.id, m)).toBeNull();
		expect((await taskRow(db, t.id))?.milestoneId).toBeNull();
		const page = await run(
			milestonePage.load,
			req(w.member, `/projects/OPS/milestones/${m}`, { params: { key: 'OPS', id: m } })
		);
		expect(status(page)).toBe(404);
		const loaded = (await run(
			view.load,
			req(w.member, `/projects/OPS?milestone=${m}`, { params: { key: 'OPS' } })
		)) as {
			filters: { milestone: unknown };
		};
		expect(loaded.filters.milestone).toBe('any');
		const row = await taskRow(db, t.id);
		const patched = await run(
			detail.actions.patch,
			req(w.member, '/projects/OPS/tasks/1', {
				params: { key: 'OPS', number: String(t.number) },
				form: { field: 'milestoneId', value: m, expectedUpdatedAt: String(row!.updatedAt) }
			})
		);
		expect(status(patched)).toBe(400);
		expect(
			(await bulkUpdate(db, w.member, w.ops.id, [t.id], { milestoneId: m }, Date.now())).ok
		).toBe(false);
		expect((await taskRow(db, t.id))?.milestoneId).toBeNull();
	});
});

// ── Stale edits ────────────────────────────────────────────────────────────────────────────────────────────

describe('stale-edit races compare updated_at', () => {
	it('label rename, milestone edit, column save and step edit against an old version: 409, nothing changed', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		const l = await mkLabel(w.ops.id, w.member, 'Bug');
		const m = await mkMilestone(w.ops.id, w.admin);
		const step = await addItem(db, w.member, w.ops.id, t.id, 'Step', Date.now());
		if (!step.ok) throw new Error('seed');
		const lb = await db.select().from(labels).where(eq(labels.id, l)).get();
		const mb = await db.select().from(milestones).where(eq(milestones.id, m)).get();
		const sb = await db
			.select()
			.from(taskChecklistItems)
			.where(eq(taskChecklistItems.id, step.id))
			.get();
		const stale = (n: number) => String(n - 1);
		const s = (r: unknown) => status(r);
		expect(
			s(
				await run(
					settings.actions.labelSave,
					req(w.lead, '/projects/OPS/settings', {
						params: { key: 'OPS' },
						form: { id: l, name: 'X', color: 'blue', expectedUpdatedAt: stale(lb!.updatedAt) }
					})
				)
			)
		).toBe(409);
		expect(
			s(
				await run(
					settings.actions.milestoneSave,
					req(w.lead, '/projects/OPS/settings', {
						params: { key: 'OPS' },
						form: { id: m, name: 'X', expectedUpdatedAt: stale(mb!.updatedAt) }
					})
				)
			)
		).toBe(409);
		expect(
			s(
				await run(
					settings.actions.milestoneStatus,
					req(w.lead, '/projects/OPS/settings', {
						params: { key: 'OPS' },
						form: { id: m, status: 'closed', expectedUpdatedAt: stale(mb!.updatedAt) }
					})
				)
			)
		).toBe(409);
		expect(
			s(
				await run(
					detail.actions.checkEdit,
					req(w.member, '/projects/OPS/tasks/1', {
						params: { key: 'OPS', number: '1' },
						form: { id: step.id, text: 'X', expectedUpdatedAt: stale(sb!.updatedAt) }
					})
				)
			)
		).toBe(409);
		await run(
			settings.actions.columnsSave,
			req(w.lead, '/projects/OPS/settings', {
				params: { key: 'OPS' },
				form: { expectedUpdatedAt: '0', label_todo: 'First' }
			})
		);
		expect(
			s(
				await run(
					settings.actions.columnsSave,
					req(w.lead, '/projects/OPS/settings', {
						params: { key: 'OPS' },
						form: { expectedUpdatedAt: '0', label_todo: 'Second' }
					})
				)
			)
		).toBe(409);
		expect(await db.select().from(labels).where(eq(labels.id, l)).get()).toEqual(lb);
		expect(await db.select().from(milestones).where(eq(milestones.id, m)).get()).toEqual(mb);
		expect(
			await db.select().from(taskChecklistItems).where(eq(taskChecklistItems.id, step.id)).get()
		).toEqual(sb);
		expect((await getColumns(db, w.ops.id)).columns.find((c) => c.status === 'todo')?.label).toBe(
			'First'
		);
	});
});

// ── Findings ───────────────────────────────────────────────────────────────────────────────────────────────

describe('findings', () => {
	it('FIXED L1 (was PROOF): manager-only writes carry the manage rule; a lead removed between the route check and the write gets 403 and writes nothing', async () => {
		const w = await world();
		const m = await mkMilestone(w.ops.id, w.admin);
		await seedTask(db, w.member, w.ops, { milestoneId: m });
		/** The real db, except that the first batch is preceded by the admin replacing the lead (a concurrent request). */
		const racing = (): Db => {
			let fired = false;
			return new Proxy(db, {
				get(target, prop, receiver) {
					if (prop === 'batch')
						return async (items: Parameters<Db['batch']>[0]) => {
							if (!fired) {
								fired = true;
								await target
									.update(projects)
									.set({ leadId: w.admin.id })
									.where(eq(projects.id, w.ops.id));
							}
							return target.batch(items);
						};
					const v = Reflect.get(target, prop, receiver);
					return typeof v === 'function' ? v.bind(target) : v;
				}
			});
		};
		const cols = await run(
			settings.actions.columnsSave,
			req(w.lead, '/projects/OPS/settings', {
				params: { key: 'OPS' },
				form: { expectedUpdatedAt: '0', label_done: 'Shipped by ex-lead' },
				database: racing()
			})
		);
		await db.update(projects).set({ leadId: w.lead.id }).where(eq(projects.id, w.ops.id));
		const del = await run(
			settings.actions.milestoneDelete,
			req(w.lead, '/projects/OPS/settings', {
				params: { key: 'OPS' },
				form: { id: m },
				database: racing()
			})
		);
		const project = await db.select().from(projects).where(eq(projects.id, w.ops.id)).get();
		expect(project?.leadId).toBe(w.admin.id);
		// The actor was no longer a manager when the writes ran: both are refused and nothing is stored.
		expect(status(cols)).toBe(403);
		expect((await getColumns(db, w.ops.id)).columns.find((c) => c.status === 'done')?.label).toBe(
			'Done'
		);
		expect(status(del)).toBe(403);
		expect(await getMilestone(db, w.ops.id, m)).not.toBeNull();
	});

	it('FIXED L3 (was PROOF): a 1000-character milestone description in CJK or emoji is accepted and saved', async () => {
		const w = await world();
		for (const ch of ['界', '🚀']) {
			const r = await run(
				settings.actions.milestoneSave,
				req(w.lead, '/projects/OPS/settings', {
					params: { key: 'OPS' },
					form: { name: 'Launch', description: ch.repeat(1000), dueOn: '' }
				})
			);
			expect(status(r)).toBe(200);
			expect(pm(r).ok).toBe(true);
		}
		const saved = await db.select().from(milestones);
		expect(saved.map((m) => Array.from(m.description).length)).toEqual([1000, 1000]);
	});

	it('migration: the new tables are not FTS-indexed and tasks_fts triggers keep their 0001 definition', async () => {
		const triggers = await d1
			.prepare(
				`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'tasks' ORDER BY name`
			)
			.all<{ name: string; sql: string }>();
		expect(triggers.results.map((t) => t.name)).toEqual([
			'tasks_fts_ad',
			'tasks_fts_ai',
			'tasks_fts_au'
		]);
		expect(triggers.results.find((t) => t.name === 'tasks_fts_au')?.sql).toContain(
			'AFTER UPDATE OF title, description'
		);
		const other = await d1
			.prepare(
				`SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('labels','task_labels','task_checklist_items','milestones','project_columns','saved_views')`
			)
			.first<{ n: number }>();
		expect(other?.n).toBe(0);
		const fk = await d1
			.prepare(`PRAGMA foreign_key_list(tasks)`)
			.all<{ table: string; from: string }>();
		expect(fk.results.some((r) => r.table === 'milestones' && r.from === 'milestone_id')).toBe(
			true
		);
		void sql;
	});
});
