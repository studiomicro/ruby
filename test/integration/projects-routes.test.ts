import { isHttpError, isRedirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { render } from 'svelte/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { projects, tasks } from '#lib/server/db/schema';
import Markdown from '#lib/ui/kit/Markdown.svelte';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { archive, clearAll, seedProject, seedTask, taskRow } from '../helpers/seed-tasks';
import { insertUser } from '../helpers/users';

/** RB-01 loads and actions called directly: access, validation, 404s, conflicts, moves and deletes. */

const binding: { DB?: D1Database; TEAM_TIME_ZONE: string } = { TEAM_TIME_ZONE: 'Asia/Jakarta' };
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const list = await import('../../src/routes/(app)/projects/+page.server');
const create = await import('../../src/routes/(app)/projects/new/+page.server');
const layout = await import('../../src/routes/(app)/projects/[key]/+layout.server');
const view = await import('../../src/routes/(app)/projects/[key]/+page.server');
const settings = await import('../../src/routes/(app)/projects/[key]/settings/+page.server');
const newTask = await import('../../src/routes/(app)/projects/[key]/tasks/new/+page.server');
const detail = await import('../../src/routes/(app)/projects/[key]/tasks/[number]/+page.server');
const myTasks = await import('../../src/routes/(app)/my-tasks/+page.server');

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

/** A request as `user` (null: signed out) to `path`, with the layout's data as `parent()`. */
async function req(
	user: SessionUser | null,
	path: string,
	options: {
		form?: Record<string, string> | [string, string][];
		params?: Record<string, string>;
	} = {}
) {
	const { event } = fakeEvent({
		url: `http://localhost${path}`,
		db,
		user,
		form: options.form,
		params: options.params
	});
	Object.assign(event, {
		parent: async () => (await layout.load(event as never)) as Record<string, unknown>
	});
	return event;
}

describe('access', () => {
	it('every load and action refuses a signed-out request with 401', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u, { key: 'OPS' });
		await seedTask(db, u, p);
		const params = { key: 'OPS', number: '1' };
		const form = { title: 'x' };
		const calls: [unknown, string, boolean][] = [
			[list.load, '/projects', false],
			[create.load, '/projects/new', false],
			[create.actions.default, '/projects/new', true],
			[layout.load, '/projects/OPS', false],
			[view.load, '/projects/OPS', false],
			[view.actions.move, '/projects/OPS', true],
			[settings.load, '/projects/OPS/settings', false],
			[settings.actions.update, '/projects/OPS/settings', true],
			[settings.actions.archive, '/projects/OPS/settings', true],
			[settings.actions.unarchive, '/projects/OPS/settings', true],
			[newTask.load, '/projects/OPS/tasks/new', false],
			[newTask.actions.default, '/projects/OPS/tasks/new', true],
			[detail.load, '/projects/OPS/tasks/1', false],
			[detail.actions.update, '/projects/OPS/tasks/1', true],
			[detail.actions.patch, '/projects/OPS/tasks/1', true],
			[detail.actions.delete, '/projects/OPS/tasks/1', true],
			[myTasks.load, '/my-tasks', false]
		];
		for (const [fn, path, post] of calls) {
			const result = await run(
				fn,
				await req(null, path, { params, form: post ? form : undefined })
			);
			expect(status(result), path).toBe(401);
		}
		const count = await db.select().from(tasks);
		expect(count).toHaveLength(1);
	});
});

describe('projects', () => {
	it('creates OPS from "ops"; rejects bad keys and a duplicate with field errors', async () => {
		const u = await insertUser(db);
		const ok = await run(
			create.actions.default,
			await req(u, '/projects/new', { form: { key: ' ops ', name: 'Operations' } })
		);
		expect(isRedirect(ok) && ok.location).toBe('/projects/OPS');
		for (const key of ['A', '1AB', 'ABCDEFGHIJK', 'A-B', 'ÄB', 'ßA', 'new', 'OPS']) {
			const r = await run(
				create.actions.default,
				await req(u, '/projects/new', { form: { key, name: 'X' } })
			);
			expect(status(r), key).toBe(400);
			expect((failData(r).errors as Record<string, string>).key, key).toBeTruthy();
		}
		expect(await db.select().from(projects)).toHaveLength(1);
	});

	it('/projects/ops redirects 301 to /projects/OPS (rest of the path kept); unknown keys 404', async () => {
		const u = await insertUser(db);
		await seedProject(db, u, { key: 'OPS' });
		const r = await run(
			layout.load,
			await req(u, '/projects/ops/tasks/3?x=1', { params: { key: 'ops' } })
		);
		expect(isRedirect(r) && r.status).toBe(301);
		expect(isRedirect(r) && r.location).toBe('/projects/OPS/tasks/3?x=1');
		for (const key of ['NOPE', 'a-b', '..', 'ÄB'])
			expect(
				status(await run(layout.load, await req(u, `/projects/${key}`, { params: { key } })))
			).toBe(404);
		await db.update(projects).set({ deletedAt: 1 }).where(eq(projects.key, 'OPS'));
		expect(
			status(await run(layout.load, await req(u, '/projects/OPS', { params: { key: 'OPS' } })))
		).toBe(404);
	});

	it('settings: the key cannot change; a member who is not lead/creator gets 403', async () => {
		const owner = await insertUser(db);
		const member = await insertUser(db);
		const admin = await insertUser(db, { role: 'admin' });
		const p = await seedProject(db, owner, { key: 'OPS' });
		const form = (expected: number) => ({
			key: 'HACK',
			name: 'New name',
			description: '',
			leadId: '',
			expectedUpdatedAt: String(expected)
		});
		const denied = await run(
			settings.actions.update,
			await req(member, '/projects/OPS/settings', {
				params: { key: 'OPS' },
				form: form(p.updatedAt)
			})
		);
		expect(status(denied)).toBe(403);
		const saved = await run(
			settings.actions.update,
			await req(admin, '/projects/OPS/settings', {
				params: { key: 'OPS' },
				form: form(p.updatedAt)
			})
		);
		expect(saved).toEqual({ saved: 'Project saved.' });
		const row = await db.select().from(projects).where(eq(projects.id, p.id)).get();
		expect(row).toMatchObject({ key: 'OPS', name: 'New name' });
		const stale = await run(
			settings.actions.archive,
			await req(owner, '/projects/OPS/settings', {
				params: { key: 'OPS' },
				form: { expectedUpdatedAt: String(p.updatedAt) }
			})
		);
		expect(status(stale)).toBe(409);
	});
});

describe('tasks', () => {
	const base = { status: 'todo', priority: 'none', assigneeId: '', dueOn: '', description: '' };

	it('create: validation boundaries, numbering, archived 409', async () => {
		const u = await insertUser(db);
		const off = await insertUser(db, { status: 'disabled' });
		await seedProject(db, u, { key: 'OPS' });
		const post = async (fields: Record<string, string>) =>
			run(
				newTask.actions.default,
				await req(u, '/projects/OPS/tasks/new', {
					params: { key: 'OPS' },
					form: { ...base, ...fields }
				})
			);
		const bad: [Record<string, string>, string][] = [
			[{ title: '' }, 'title'],
			[{ title: 'x'.repeat(201) }, 'title'],
			[{ title: 'ok', description: 'd'.repeat(20_001) }, 'description'],
			[{ title: 'ok', status: 'doing' }, 'status'],
			[{ title: 'ok', priority: 'p0' }, 'priority'],
			[{ title: 'ok', dueOn: '2026-02-30' }, 'dueOn'],
			[{ title: 'ok', dueOn: '2026-1-1' }, 'dueOn'],
			[{ title: 'ok', assigneeId: off.id }, 'assigneeId'],
			[{ title: 'ok', assigneeId: 'not-a-uuid' }, 'assigneeId']
		];
		for (const [fields, field] of bad) {
			const r = await post(fields);
			expect(status(r), field).toBe(400);
			expect((failData(r).errors as Record<string, string>)[field], field).toBeTruthy();
		}
		const first = await post({ title: 'x'.repeat(200), description: 'd'.repeat(20_000) });
		expect(isRedirect(first) && first.location).toBe('/projects/OPS/tasks/1');
		const second = await post({ title: 'Second', dueOn: '2026-12-31' });
		expect(isRedirect(second) && second.location).toBe('/projects/OPS/tasks/2');
		await archive(db, (await db.select().from(projects).get())!.id);
		expect(status(await post({ title: 'Late' }))).toBe(409);
		expect(await db.select().from(tasks)).toHaveLength(2);
	});

	it('detail: malformed, unknown and deleted numbers are 404', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u, { key: 'OPS' });
		const t = await seedTask(db, u, p);
		const load = async (number: string) =>
			status(
				await run(
					detail.load,
					await req(u, `/projects/OPS/tasks/${number}`, { params: { key: 'OPS', number } })
				)
			);
		for (const n of ['0', 'abc', '99999999999', '01', '2', '-1'])
			expect(await load(n), n).toBe(404);
		expect(await load('1')).toBe(200);
		await db.update(tasks).set({ deletedAt: 1 }).where(eq(tasks.id, t.id));
		expect(await load('1')).toBe(404);
	});

	it('update: a stale version answers 409 with both values; keep mine succeeds', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u, { key: 'OPS' });
		const t = await seedTask(db, u, p, { title: 'Original' }, 1_000);
		const params = { key: 'OPS', number: '1' };
		const theirs = await run(
			detail.actions.patch,
			await req(u, '/projects/OPS/tasks/1', {
				params,
				form: { field: 'title', value: 'Theirs', expectedUpdatedAt: '1000' }
			})
		);
		expect(theirs).toEqual({ kind: 'patch', patched: 'title' });
		const stale = await run(
			detail.actions.update,
			await req(u, '/projects/OPS/tasks/1', {
				params,
				form: { title: 'Mine', description: 'Body', expectedUpdatedAt: '1000' }
			})
		);
		expect(status(stale)).toBe(409);
		const conflict = failData(stale).conflict as {
			fields: { field: string; theirs: string; mine: string }[];
			mine: Record<string, string>;
			expectedUpdatedAt: number;
		};
		expect(conflict.fields).toEqual([
			{ field: 'title', label: 'Title', theirs: 'Theirs', mine: 'Mine' },
			{ field: 'description', label: 'Description', theirs: '(empty)', mine: 'Body' }
		]);
		expect((await taskRow(db, t.id))?.title).toBe('Theirs');
		const keep = await run(
			detail.actions.update,
			await req(u, '/projects/OPS/tasks/1', {
				params,
				form: { ...conflict.mine, expectedUpdatedAt: String(conflict.expectedUpdatedAt) }
			})
		);
		expect(isRedirect(keep) && keep.location).toBe('/projects/OPS/tasks/1?saved=1');
		expect(await taskRow(db, t.id)).toMatchObject({ title: 'Mine', description: 'Body' });
	});

	it('delete: 403 for a member who is not creator or lead (no change); creator needs the confirm box', async () => {
		const creator = await insertUser(db);
		const member = await insertUser(db);
		const p = await seedProject(db, creator, { key: 'OPS' });
		const t = await seedTask(db, creator, p);
		const params = { key: 'OPS', number: '1' };
		const denied = await run(
			detail.actions.delete,
			await req(member, '/projects/OPS/tasks/1', { params, form: { confirm: 'yes' } })
		);
		expect(status(denied)).toBe(403);
		expect((await taskRow(db, t.id))?.deletedAt).toBeNull();
		const unconfirmed = await run(
			detail.actions.delete,
			await req(creator, '/projects/OPS/tasks/1', { params, form: {} })
		);
		expect(status(unconfirmed)).toBe(400);
		const done = await run(
			detail.actions.delete,
			await req(creator, '/projects/OPS/tasks/1', { params, form: { confirm: 'yes' } })
		);
		expect(isRedirect(done) && done.location).toBe('/projects/OPS?deleted=OPS-1');
		expect((await taskRow(db, t.id))?.deletedAt).not.toBeNull();
	});

	it('archived project: patch, update, move and delete are refused server-side; reads work', async () => {
		const admin = await insertUser(db, { role: 'admin' });
		const p = await seedProject(db, admin, { key: 'OPS' });
		const t = await seedTask(db, admin, p);
		const row = (await taskRow(db, t.id))!;
		await archive(db, p.id);
		const params = { key: 'OPS', number: '1' };
		const expected = String(row.updatedAt);
		const results = [
			await run(
				detail.actions.patch,
				await req(admin, '/projects/OPS/tasks/1', {
					params,
					form: { field: 'status', value: 'done', expectedUpdatedAt: expected }
				})
			),
			await run(
				detail.actions.update,
				await req(admin, '/projects/OPS/tasks/1', {
					params,
					form: { title: 'X', expectedUpdatedAt: expected }
				})
			),
			await run(
				view.actions.move,
				await req(admin, '/projects/OPS', {
					params,
					form: { taskId: t.id, status: 'done', place: 'top' }
				})
			),
			await run(
				detail.actions.delete,
				await req(admin, '/projects/OPS/tasks/1', { params, form: { confirm: 'yes' } })
			)
		];
		expect(results.map(status)).toEqual([409, 409, 409, 409]);
		expect(await taskRow(db, t.id)).toMatchObject({ status: 'todo', deletedAt: null });
		expect(
			status(await run(detail.load, await req(admin, '/projects/OPS/tasks/1', { params })))
		).toBe(200);
	});

	it('move (no-JS form): status + place; afterTaskId from another project is ignored', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u, { key: 'OPS' });
		const q = await seedProject(db, u, { key: 'OTH' });
		const a = await seedTask(db, u, p);
		const b = await seedTask(db, u, p, { status: 'done' });
		const foreign = await seedTask(db, u, q, { status: 'done' });
		const move = async (form: Record<string, string>) =>
			run(view.actions.move, await req(u, '/projects/OPS', { params: { key: 'OPS' }, form }));
		expect(await move({ taskId: a.id, status: 'done', place: 'top' })).toEqual({
			moved: { taskId: a.id, status: 'done' }
		});
		expect((await taskRow(db, a.id))!.position).toBeLessThan((await taskRow(db, b.id))!.position);
		await move({ taskId: a.id, status: 'done', afterTaskId: foreign.id });
		expect((await taskRow(db, a.id))!.position).toBeGreaterThan(
			(await taskRow(db, b.id))!.position
		);
		expect(status(await move({ taskId: foreign.id, status: 'todo', place: 'top' }))).toBe(404);
		expect(
			status(await move({ taskId: a.id, status: 'todo', place: 'top', afterTaskId: '' }))
		).toBe(400);
		expect(status(await move({ taskId: a.id, status: 'nope', place: 'top' }))).toBe(400);
	});

	it('list load: filters from the URL, invalid values ignored, page size 50', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u, { key: 'OPS' });
		await seedTask(db, u, p, { assigneeId: u.id, priority: 'high' });
		await seedTask(db, u, p);
		const data = (await run(
			view.load,
			await req(u, '/projects/OPS?assignee=me&status=bogus&page=abc', { params: { key: 'OPS' } })
		)) as { list: { total: number }; page: number; pageSize: number; view: string };
		expect(data).toMatchObject({ view: 'list', page: 1, pageSize: 50, list: { total: 1 } });
		const board = (await run(
			view.load,
			await req(u, '/projects/OPS?view=board&status=todo', { params: { key: 'OPS' } })
		)) as { board: { status: string; count: number }[] };
		expect(board.board).toEqual([expect.objectContaining({ status: 'todo', count: 2 })]);
	});

	it('my tasks load uses the team date', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u, { key: 'OPS' });
		await seedTask(db, u, p, { assigneeId: u.id, dueOn: '2000-01-01' });
		const data = (await run(myTasks.load, await req(u, '/my-tasks'))) as {
			today: string;
			groups: { overdue: unknown[] };
			closed: unknown[];
		};
		expect(data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(data.groups.overdue).toHaveLength(1);
		expect(data.closed).toEqual([]);
	});

	it('a description with <script> and a javascript: link renders inert', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u, { key: 'OPS' });
		await seedTask(db, u, p, {
			description:
				'<script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src=x onerror=alert(1)>'
		});
		const data = (await run(
			detail.load,
			await req(u, '/projects/OPS/tasks/1', { params: { key: 'OPS', number: '1' } })
		)) as { task: { description: string } };
		const { body } = render(Markdown, { props: { source: data.task.description } });
		expect(body).not.toMatch(/<script/i);
		expect(body).not.toMatch(/href="javascript:/i);
		expect(body).not.toMatch(/<img[^>]*onerror/i);
	});
});
