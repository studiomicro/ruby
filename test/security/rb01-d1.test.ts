import { isHttpError, isRedirect } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { render } from 'svelte/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Markdown from '#lib/ui/kit/Markdown.svelte';
import type { SessionUser } from '#lib/server/auth/session';
import { sessionCookieName } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { notifications, projects, tasks } from '#lib/server/db/schema';
import {
	boardTasks,
	listMyTasks,
	listTasks,
	moveTask,
	renumberColumn,
	updateTask
} from '#lib/server/tasks/repo';
import { projectOpenCounts } from '#lib/server/projects/repo';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import {
	archive,
	assignedNotifications,
	clearAll,
	seedProject,
	seedTask,
	taskRow
} from '../helpers/seed-tasks';
import { insertSession, insertUser } from '../helpers/users';

/**
 * Red-team probes for RB-01 against a fresh local D1 (docs/features/rb-01-projects-tasks/SECURITY_REPORT.md).
 * Tests named `PROOF` document a finding. Those marked "(fixed)" assert the fixed behaviour (RB-01 cycle 2: L1, L2,
 * L4); before the fix they asserted the weak behaviour. L3's proof was removed: no search module exists on main yet,
 * and RB-02's search must prove live-rows-only itself. Every other test asserts a defence that holds.
 */

const binding: {
	DB?: D1Database;
	TEAM_TIME_ZONE: string;
	ACCESS_TEAM_DOMAIN: string;
	ACCESS_AUD: string;
} = { TEAM_TIME_ZONE: 'UTC', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' };
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const { handle } = await import('../../src/hooks.server');
const create = await import('../../src/routes/(app)/projects/new/+page.server');
const layout = await import('../../src/routes/(app)/projects/[key]/+layout.server');
const view = await import('../../src/routes/(app)/projects/[key]/+page.server');
const settings = await import('../../src/routes/(app)/projects/[key]/settings/+page.server');
const newTask = await import('../../src/routes/(app)/projects/[key]/tasks/new/+page.server');
const detail = await import('../../src/routes/(app)/projects/[key]/tasks/[number]/+page.server');

let db: Db;
let dispose: () => Promise<void>;
beforeAll(async () => {
	const opened = await openLocalD1();
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
const failData = (r: unknown) => (r as { data: Record<string, unknown> }).data;

function req(
	user: SessionUser | null,
	path: string,
	options: {
		form?: Record<string, string> | [string, string][];
		params?: Record<string, string>;
		headers?: Record<string, string>;
	} = {}
) {
	const { event } = fakeEvent({
		url: `http://localhost${path}`,
		db,
		user,
		form: options.form,
		params: options.params,
		headers: options.headers
	});
	Object.assign(event, {
		parent: async () => (await layout.load(event as never)) as Record<string, unknown>
	});
	return event;
}

async function world() {
	const admin = await insertUser(db, { role: 'admin', name: 'Ada Admin' });
	const lead = await insertUser(db, { name: 'Lee Lead' });
	const creator = await insertUser(db, { name: 'Cora Creator' });
	const member = await insertUser(db, { name: 'Mo Member' });
	const other = await insertUser(db, { name: 'Oli Other' });
	const disabled = await insertUser(db, { name: 'Dee Disabled', status: 'disabled' });
	const ops = await seedProject(db, creator, { key: 'OPS', leadId: lead.id });
	const fin = await seedProject(db, creator, { key: 'FIN' });
	return { admin, lead, creator, member, other, disabled, ops, fin };
}

const projectNow = async (id: string) =>
	db.select().from(projects).where(eq(projects.id, id)).get();

describe('authorization per action', () => {
	it('settings update/archive/unarchive: member 403 with no change; lead, creator and admin allowed', async () => {
		const w = await world();
		for (const action of ['update', 'archive', 'unarchive'] as const) {
			const before = await projectNow(w.ops.id);
			const r = await run(
				settings.actions[action],
				req(w.member, '/projects/OPS/settings', {
					params: { key: 'OPS' },
					form: { name: 'Pwned', expectedUpdatedAt: String(before?.updatedAt) }
				})
			);
			expect(status(r), action).toBe(403);
			expect(await projectNow(w.ops.id)).toEqual(before);
		}
		for (const actor of [w.lead, w.creator, w.admin]) {
			const before = await projectNow(w.ops.id);
			const r = await run(
				settings.actions.update,
				req(actor, '/projects/OPS/settings', {
					params: { key: 'OPS' },
					form: {
						name: `By ${actor.name}`,
						key: 'HACK',
						leadId: w.lead.id,
						expectedUpdatedAt: String(before?.updatedAt)
					}
				})
			);
			expect(status(r), actor.name).toBe(200);
			const after = await projectNow(w.ops.id);
			expect(after?.name).toBe(`By ${actor.name}`);
			expect(after?.key).toBe('OPS');
		}
	});

	it('the SQL guard alone refuses a non-manager (route check bypassed): updateProject returns forbidden', async () => {
		const w = await world();
		const { updateProject, setProjectArchived } = await import('#lib/server/projects/repo');
		const p = await projectNow(w.ops.id);
		const u = await updateProject(
			db,
			w.member,
			w.ops.id,
			{ name: 'x', description: '', leadId: w.member.id },
			p!.updatedAt,
			Date.now()
		);
		expect(u).toMatchObject({ ok: false, reason: 'forbidden' });
		const a = await setProjectArchived(db, w.member, w.ops.id, true, p!.updatedAt, Date.now());
		expect(a).toMatchObject({ ok: false, reason: 'forbidden' });
		expect((await projectNow(w.ops.id))?.status).toBe('active');
	});

	it('delete: member 403 (row unchanged); task creator, project lead and admin may delete', async () => {
		const w = await world();
		const victims = [];
		for (let i = 0; i < 3; i++) victims.push(await seedTask(db, w.other, w.ops));
		const r = await run(
			detail.actions.delete,
			req(w.member, '/projects/OPS/tasks/1', {
				params: { key: 'OPS', number: '1' },
				form: { confirm: 'yes' }
			})
		);
		expect(status(r)).toBe(403);
		expect((await taskRow(db, victims[0]!.id))?.deletedAt).toBeNull();
		for (const [i, actor] of [w.other, w.lead, w.admin].entries()) {
			const n = String(victims[i]!.number);
			const ok = await run(
				detail.actions.delete,
				req(actor, `/projects/OPS/tasks/${n}`, {
					params: { key: 'OPS', number: n },
					form: { confirm: 'yes' }
				})
			);
			expect(status(ok), actor.name).toBe(303);
			expect((await taskRow(db, victims[i]!.id))?.deletedAt).not.toBeNull();
		}
	});

	it('the project creator who is not lead cannot delete another user’s task (rule is lead, not creator)', async () => {
		const w = await world();
		await seedTask(db, w.other, w.ops);
		const r = await run(
			detail.actions.delete,
			req(w.creator, '/projects/OPS/tasks/1', {
				params: { key: 'OPS', number: '1' },
				form: { confirm: 'yes' }
			})
		);
		expect(status(r)).toBe(403);
	});

	it('a disabled user’s live session is dropped by the hook: the move action never runs', async () => {
		const w = await world();
		await seedTask(db, w.member, w.ops);
		const token = await insertSession(db, w.disabled.id);
		const resolve = vi.fn(async () => new Response('ran'));
		const { event } = fakeEvent({
			url: 'http://localhost/projects/OPS?/move',
			routeId: '/(app)/projects/[key]',
			db,
			cookies: { [sessionCookieName(false)]: token },
			form: { taskId: crypto.randomUUID(), status: 'done', place: 'top' }
		});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const response = await handle({ event, resolve } as never);
		expect(event.locals.user).toBeNull();
		expect(resolve).not.toHaveBeenCalled();
		expect([302, 303, 401]).toContain(response.status);
	});

	it('CSRF: a cross-site or Origin-less form POST to a task action is refused before routing', async () => {
		const w = await world();
		await seedTask(db, w.member, w.ops);
		for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }]) {
			const token = await insertSession(db, w.member.id);
			const resolve = vi.fn(async () => new Response('ran'));
			const { event } = fakeEvent({
				url: 'http://localhost/projects/OPS/tasks/1?/delete',
				routeId: '/(app)/projects/[key]/tasks/[number]',
				db,
				cookies: { [sessionCookieName(false)]: token },
				form: { confirm: 'yes' },
				headers
			});
			const response = await handle({ event, resolve } as never);
			expect(response.status).toBe(403);
			expect(resolve).not.toHaveBeenCalled();
		}
		expect((await db.select().from(tasks)).every((t) => t.deletedAt === null)).toBe(true);
	});
});

describe('IDOR via form-supplied ids', () => {
	it('move with a taskId from another project is a 404 and changes nothing', async () => {
		const w = await world();
		const foreign = await seedTask(db, w.member, w.fin);
		const before = await taskRow(db, foreign.id);
		const r = await run(
			view.actions.move,
			req(w.member, '/projects/OPS', {
				params: { key: 'OPS' },
				form: { taskId: foreign.id, status: 'done', place: 'top' }
			})
		);
		expect(status(r)).toBe(404);
		expect(await taskRow(db, foreign.id)).toEqual(before);
	});

	it('afterTaskId from another project, another column, deleted or self lands at the bottom', async () => {
		const w = await world();
		const a = await seedTask(db, w.member, w.ops);
		const b = await seedTask(db, w.member, w.ops);
		const foreign = await seedTask(db, w.member, w.fin);
		const otherCol = await seedTask(db, w.member, w.ops, { status: 'done' });
		const moving = await seedTask(db, w.member, w.ops, { status: 'backlog' });
		for (const after of [foreign.id, otherCol.id, moving.id, crypto.randomUUID()]) {
			const r = await moveTask(db, w.ops, moving.id, 'todo', { after }, Date.now());
			expect(r.ok).toBe(true);
			const col = await db
				.select({ id: tasks.id, position: tasks.position })
				.from(tasks)
				.where(sql`${tasks.projectId} = ${w.ops.id} and ${tasks.status} = 'todo'`)
				.orderBy(tasks.position, tasks.number);
			expect(col.at(-1)?.id).toBe(moving.id);
			// Moving back so the next round starts the same way.
			await moveTask(db, w.ops, moving.id, 'backlog', { place: 'top' }, Date.now());
		}
		expect((await taskRow(db, foreign.id))?.status).toBe('todo');
		expect([a, b].length).toBe(2);
	});

	it('assigning to a disabled or nonexistent user is refused (create, patch, update) with no notification', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		for (const id of [w.disabled.id, crypto.randomUUID()]) {
			const c = await run(
				newTask.actions.default,
				req(w.member, '/projects/OPS/tasks/new', {
					params: { key: 'OPS' },
					form: { title: 'x', assigneeId: id }
				})
			);
			expect(status(c)).toBe(400);
			const row = await taskRow(db, t.id);
			const p = await run(
				detail.actions.patch,
				req(w.member, '/projects/OPS/tasks/1', {
					params: { key: 'OPS', number: '1' },
					form: { field: 'assigneeId', value: id, expectedUpdatedAt: String(row?.updatedAt) }
				})
			);
			expect(status(p)).toBe(400);
			const u = await run(
				detail.actions.update,
				req(w.member, '/projects/OPS/tasks/1', {
					params: { key: 'OPS', number: '1' },
					form: { title: 'x', assigneeId: id, expectedUpdatedAt: String(row?.updatedAt) }
				})
			);
			expect(status(u)).toBe(400);
			expect((await taskRow(db, t.id))?.assigneeId).toBeNull();
		}
		expect(await db.select().from(tasks)).toHaveLength(1);
		expect(await db.select().from(notifications)).toHaveLength(0);
	});

	it('a project lead must be an active user: disabled or unknown leadId refused on create and edit', async () => {
		const w = await world();
		for (const leadId of [w.disabled.id, crypto.randomUUID()]) {
			const c = await run(
				create.actions.default,
				req(w.member, '/projects/new', { form: { key: 'NEWP', name: 'x', leadId } })
			);
			expect(status(c)).toBe(400);
			const p = await projectNow(w.ops.id);
			const e = await run(
				settings.actions.update,
				req(w.lead, '/projects/OPS/settings', {
					params: { key: 'OPS' },
					form: { name: 'x', leadId, expectedUpdatedAt: String(p?.updatedAt) }
				})
			);
			expect(status(e)).toBe(400);
		}
		expect((await projectNow(w.ops.id))?.leadId).toBe(w.lead.id);
	});
});

describe('archived-project freeze', () => {
	it('every task mutation is refused server side (409) and changes nothing', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		await archive(db, w.ops.id);
		const row = await taskRow(db, t.id);
		const v = String(row?.updatedAt);
		const p = { key: 'OPS', number: '1' };
		const attempts: [unknown, string, Record<string, string>][] = [
			[newTask.actions.default, '/projects/OPS/tasks/new', { title: 'x' }],
			[detail.actions.update, '/projects/OPS/tasks/1', { title: 'y', expectedUpdatedAt: v }],
			[
				detail.actions.patch,
				'/projects/OPS/tasks/1',
				{ field: 'status', value: 'done', expectedUpdatedAt: v }
			],
			[detail.actions.delete, '/projects/OPS/tasks/1', { confirm: 'yes' }],
			[view.actions.move, '/projects/OPS', { taskId: t.id, status: 'done', place: 'top' }]
		];
		for (const [fn, path, form] of attempts) {
			const r = await run(fn, req(w.admin, path, { params: p, form }));
			expect(status(r), path + JSON.stringify(form)).toBe(409);
		}
		expect(await taskRow(db, t.id)).toEqual(row);
		expect(await db.select().from(tasks)).toHaveLength(1);
	});

	it('archive racing a write: a write that read the project as active is still refused by the SQL guard', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		const row = await taskRow(db, t.id);
		await archive(db, w.ops.id); // after the route's read, before the write
		const r = await updateTask(
			db,
			w.member,
			w.ops,
			{ id: t.id, assigneeId: null },
			{ title: 'late', assigneeId: w.other.id },
			row!.updatedAt,
			Date.now()
		);
		expect(r).toMatchObject({ ok: false, reason: 'archived' });
		expect((await taskRow(db, t.id))?.title).toBe(row?.title);
		expect(await assignedNotifications(db)).toHaveLength(0);
	});
});

describe('optimistic concurrency and races', () => {
	it('20 concurrent creates get numbers 1..20 exactly once', async () => {
		const w = await world();
		const { createTask } = await import('#lib/server/tasks/repo');
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				createTask(
					db,
					w.member,
					w.ops,
					{
						title: `t${i}`,
						description: '',
						status: 'todo',
						priority: 'none',
						assigneeId: null,
						dueOn: null,
						milestoneId: null
					},
					Date.now()
				)
			)
		);
		const numbers = results.map((r) => (r.ok ? r.number : -1)).sort((a, b) => a - b);
		expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
		expect((await projectNow(w.ops.id))?.nextTaskNumber).toBe(21);
	});

	it('two concurrent reassignments from one version: one wins, one 409, exactly one notification', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		const row = await taskRow(db, t.id);
		const at = Date.now();
		const [a, b] = await Promise.all(
			[w.lead, w.other].map((to) =>
				updateTask(
					db,
					w.member,
					w.ops,
					{ id: t.id, assigneeId: null },
					{ assigneeId: to.id },
					row!.updatedAt,
					at
				)
			)
		);
		expect([a?.ok, b?.ok].filter(Boolean)).toHaveLength(1);
		const notes = await assignedNotifications(db);
		expect(notes).toHaveLength(1);
		expect(notes[0]?.userId).toBe((await taskRow(db, t.id))?.assigneeId);
	});

	it('move vs delete: a move after a delete is a 404 and does not resurrect or rewrite the task', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		const [del, mv] = await Promise.all([
			run(
				detail.actions.delete,
				req(w.member, '/projects/OPS/tasks/1', {
					params: { key: 'OPS', number: '1' },
					form: { confirm: 'yes' }
				})
			),
			moveTask(db, w.ops, t.id, 'done', { place: 'top' }, Date.now())
		]);
		expect(status(del)).toBe(303);
		const row = await taskRow(db, t.id);
		expect(row?.deletedAt).not.toBeNull();
		const late = await moveTask(db, w.ops, t.id, 'in_review', { place: 'top' }, Date.now());
		expect(late).toMatchObject({ ok: false, reason: 'not_found' });
		expect((await taskRow(db, t.id))?.status).toBe(row?.status);
		expect(mv).toBeDefined();
	});

	it('a stale expectedUpdatedAt (or a forged future one) writes nothing', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		const row = await taskRow(db, t.id);
		for (const v of [String(row!.updatedAt - 1), String(row!.updatedAt + 1), '9007199254740991']) {
			const r = await run(
				detail.actions.patch,
				req(w.member, '/projects/OPS/tasks/1', {
					params: { key: 'OPS', number: '1' },
					form: { field: 'title', value: 'forged', expectedUpdatedAt: v }
				})
			);
			expect(status(r), v).toBe(409);
		}
		for (const v of ['-1', '1e3', '0x10', '', '9999999999999999', '99999999999999999999']) {
			const r = await run(
				detail.actions.patch,
				req(w.member, '/projects/OPS/tasks/1', {
					params: { key: 'OPS', number: '1' },
					form: { field: 'title', value: 'forged', expectedUpdatedAt: v }
				})
			);
			expect(status(r), v).toBe(400);
		}
		expect(await taskRow(db, t.id)).toEqual(row);
	});
});

describe('assigned notification', () => {
	it('self-assign, unassign and no-change insert nothing; a disabled assignee kept unchanged is not re-notified', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops, { assigneeId: w.member.id });
		expect(await assignedNotifications(db)).toHaveLength(0);
		let row = await taskRow(db, t.id);
		await updateTask(
			db,
			w.member,
			w.ops,
			{ id: t.id, assigneeId: w.member.id },
			{ assigneeId: w.member.id, title: 'z' },
			row!.updatedAt,
			Date.now()
		);
		row = await taskRow(db, t.id);
		await updateTask(
			db,
			w.member,
			w.ops,
			{ id: t.id, assigneeId: w.member.id },
			{ assigneeId: null },
			row!.updatedAt,
			Date.now()
		);
		expect(await assignedNotifications(db)).toHaveLength(0);
		// A task still assigned to someone who was disabled later: editing it keeps the assignee and notifies nobody.
		const kept = await seedTask(db, w.member, w.ops, { assigneeId: w.other.id });
		await db.run(sql`update users set status = 'disabled' where id = ${w.other.id}`);
		const before = (await assignedNotifications(db)).length;
		const k = await taskRow(db, kept.id);
		const r = await updateTask(
			db,
			w.member,
			w.ops,
			{ id: kept.id, assigneeId: w.other.id },
			{ assigneeId: w.other.id, title: 'edit' },
			k!.updatedAt,
			Date.now()
		);
		expect(r.ok).toBe(true);
		expect(await assignedNotifications(db)).toHaveLength(before);
	});

	it('PROOF L2 (fixed): a reassign loop A→B→A leaves one unread assigned row for B, not one per round', async () => {
		const w = await world();
		const t = await seedTask(db, w.member, w.ops);
		for (let i = 0; i < 50; i++) {
			for (const to of [w.lead.id, w.member.id]) {
				const row = await taskRow(db, t.id);
				const r = await run(
					detail.actions.patch,
					req(w.member, '/projects/OPS/tasks/1', {
						params: { key: 'OPS', number: '1' },
						form: { field: 'assigneeId', value: to, expectedUpdatedAt: String(row?.updatedAt) }
					})
				);
				expect(status(r)).toBe(200);
			}
		}
		expect(await assignedNotifications(db, w.lead.id)).toHaveLength(1);
	});
});

describe('soft-delete leaks', () => {
	it('a deleted task leaves list, board, counts, My tasks and its URL; its number is not reused', async () => {
		const w = await world();
		const live = await seedTask(db, w.member, w.ops, { assigneeId: w.member.id });
		const gone = await seedTask(db, w.member, w.ops, {
			assigneeId: w.member.id,
			title: 'zebraquartz'
		});
		const r = await run(
			detail.actions.delete,
			req(w.member, `/projects/OPS/tasks/${gone.number}`, {
				params: { key: 'OPS', number: String(gone.number) },
				form: { confirm: 'yes' }
			})
		);
		expect(status(r)).toBe(303);
		const filters = {
			statuses: [],
			priorities: [],
			assignee: 'any' as const,
			labels: [],
			milestone: 'any' as const
		};
		const list = await listTasks(
			db,
			w.ops.id,
			filters,
			{ sort: 'number', dir: 'desc' },
			1,
			w.member.id
		);
		expect(list.rows.map((x) => x.id)).toEqual([live.id]);
		expect(list.total).toBe(1);
		const board = await boardTasks(db, w.ops.id, filters, w.member.id);
		expect(board.find((c) => c.status === 'todo')?.count).toBe(1);
		expect((await projectOpenCounts(db, [w.ops.id])).get(w.ops.id)).toBe(1);
		const mine = await listMyTasks(db, w.member.id, { closed: true }, '2026-10-26');
		expect(
			Object.values(mine.groups)
				.flat()
				.map((x) => x.id)
		).toEqual([live.id]);
		const d = await run(
			detail.load,
			req(w.member, `/projects/OPS/tasks/${gone.number}`, {
				params: { key: 'OPS', number: String(gone.number) }
			})
		);
		expect(status(d)).toBe(404);
		const again = await seedTask(db, w.member, w.ops);
		expect(again.number).toBe(gone.number + 1);
	});
});

describe('routes, keys, redirects and query params', () => {
	it('the case redirect never leaves /projects/<KEY> (no open redirect via // or encoded slashes)', async () => {
		const w = await world();
		for (const path of [
			'/projects/ops//evil.example',
			'/projects/ops/%2F%2Fevil.example',
			'/projects/ops/..%2F..%2Fx'
		]) {
			const r = await run(layout.load, req(w.member, path, { params: { key: 'ops' } }));
			expect(isRedirect(r), path).toBe(true);
			const loc = (r as { location: string }).location;
			expect(loc.startsWith('/projects/OPS/'), loc).toBe(true);
			expect(new URL(loc, 'http://localhost').origin).toBe('http://localhost');
		}
	});

	it('keys: reserved, unicode lookalikes and case duplicates are refused; static /new is never shadowed', async () => {
		const w = await world();
		for (const key of [
			'new',
			'NEW',
			'New',
			'ОPS',
			'ＯＰＳ',
			'OPS​',
			'OP\u0000S',
			'ops',
			'Ops',
			'Fin'
		]) {
			const r = await run(
				create.actions.default,
				req(w.member, '/projects/new', { form: { key, name: 'Lookalike' } })
			);
			expect(status(r), JSON.stringify(key)).toBe(400);
		}
		for (const key of ['ОPS', 'ＯＰＳ', 'OPS%00', 'O']) {
			const r = await run(
				layout.load,
				req(w.member, `/projects/${encodeURIComponent(key)}`, { params: { key } })
			);
			expect(status(r), key).toBe(404);
		}
		expect(await db.select().from(projects)).toHaveLength(2);
	});

	it('filter, sort and page params cannot inject SQL or blow up: huge and hostile lists are ignored', async () => {
		const w = await world();
		await seedTask(db, w.member, w.ops);
		const evil = [
			"todo') or 1=1 --",
			'"]',
			'done","x',
			...Array.from({ length: 5000 }, () => 'todo'),
			...Array.from({ length: 200 }, (_, i) => `s${i}`)
		];
		const qs = new URLSearchParams();
		for (const s of evil) qs.append('status', s);
		for (const p of ['high', "x' union select password_hash from user_passwords --"])
			qs.append('priority', p);
		qs.set('assignee', "' or 1=1 --");
		qs.set('sort', 'number; drop table tasks');
		qs.set('dir', 'desc, (select 1)');
		qs.set('page', '99999999999');
		for (const v of ['list', 'board']) {
			qs.set('view', v);
			const r = await run(
				view.load,
				req(w.member, `/projects/OPS?${qs}`, { params: { key: 'OPS' } })
			);
			const data = r as {
				filters: { statuses: string[]; assignee: unknown };
				sort: { sort: string; dir: string };
				page: number;
			};
			expect(data.filters.statuses).toEqual(['todo']);
			expect(data.filters.assignee).toBe('any');
			expect(data.sort).toEqual({ sort: 'number', dir: 'desc' });
			expect(data.page).toBe(1);
		}
		expect(await db.select().from(tasks)).toHaveLength(1);
	});

	it('task number params: 0, letters, 10 digits, signs and padding are 404', async () => {
		const w = await world();
		await seedTask(db, w.member, w.ops);
		for (const n of ['0', '01', 'abc', '99999999999', '-1', '1e2', '1.0', ' 1']) {
			const r = await run(
				detail.load,
				req(w.member, `/projects/OPS/tasks/${n}`, { params: { key: 'OPS', number: n } })
			);
			expect(status(r), n).toBe(404);
		}
	});
});

describe('body caps and Markdown', () => {
	it('an over-cap body is a 400 (not a 500) on every Markdown form; 20 001 chars is a field error', async () => {
		const w = await world();
		await seedTask(db, w.member, w.ops);
		const row = (await db.select().from(tasks))[0];
		const huge = 'x'.repeat(300 * 1024);
		const p = { key: 'OPS', number: '1' };
		for (const [fn, path, form] of [
			[newTask.actions.default, '/projects/OPS/tasks/new', { title: 't', description: huge }],
			[
				detail.actions.update,
				'/projects/OPS/tasks/1',
				{ title: 't', description: huge, expectedUpdatedAt: String(row?.updatedAt) }
			],
			[
				detail.actions.patch,
				'/projects/OPS/tasks/1',
				{ field: 'description', value: huge, expectedUpdatedAt: String(row?.updatedAt) }
			],
			[create.actions.default, '/projects/new', { key: 'BIG', name: 'b', description: huge }],
			[
				view.actions.move,
				'/projects/OPS',
				{ taskId: row!.id, status: 'done', place: 'top', pad: 'y'.repeat(9000) }
			]
		] as const) {
			const r = await run(
				fn,
				req(w.member, path, { params: p, form: form as Record<string, string> })
			);
			expect(status(r), path).toBe(400);
		}
		const over = await run(
			detail.actions.patch,
			req(w.member, '/projects/OPS/tasks/1', {
				params: p,
				form: {
					field: 'description',
					value: 'é'.repeat(20_001),
					expectedUpdatedAt: String(row?.updatedAt)
				}
			})
		);
		expect(status(over)).toBe(400);
		expect(failData(over).errors).toHaveProperty('description');
		expect((await db.select().from(tasks))[0]?.description).toBe('');
	});

	it('PROOF L4 (fixed): renumbering a column of an archived project changes no position', async () => {
		const w = await world();
		const a = await seedTask(db, w.member, w.ops);
		const b = await seedTask(db, w.member, w.ops);
		await db.update(tasks).set({ position: 1 }).where(eq(tasks.id, a.id));
		await db
			.update(tasks)
			.set({ position: 1 + 1e-7 })
			.where(eq(tasks.id, b.id));
		await db.update(projects).set({ status: 'archived' }).where(eq(projects.id, w.ops.id));
		await renumberColumn(db, w.ops.id, 'todo');
		expect((await taskRow(db, a.id))?.position).toBe(1);
		expect((await taskRow(db, b.id))?.position).toBe(1 + 1e-7);
	});

	it('PROOF L1 (fixed): the task page renders a mention with the mentioned user’s real name, not the typed label', async () => {
		const w = await world();
		const forged = `Please approve. @[Ada Admin (CEO)](user:${w.member.id})`;
		const t = await seedTask(db, w.member, w.ops, { description: forged });
		const data = (await run(
			detail.load,
			req(w.member, `/projects/OPS/tasks/${t.number}`, {
				params: { key: 'OPS', number: String(t.number) }
			})
		)) as { names: Map<string, string>; task: { description: string } };
		expect(data.names.get(w.member.id)).toBe(w.member.name);
		const { body } = render(Markdown, {
			props: { source: data.task.description, names: data.names }
		});
		expect(body).toContain(`@${w.member.name}`);
		expect(body).not.toContain('Ada Admin (CEO)');
	});
});
