import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb, type Db } from '#lib/server/db';
import { notifications, projects, tasks, users } from '#lib/server/db/schema';
import {
	createProject,
	getProjectByKey,
	listProjects,
	projectOpenCounts,
	setProjectArchived,
	updateProject
} from '#lib/server/projects/repo';
import {
	boardTasks,
	createTask,
	deleteTask,
	getTaskByNumber,
	listMyTasks,
	listTasks,
	moveTask,
	patchTask,
	renumberColumn,
	updateTask
} from '#lib/server/tasks/repo';
import { parseFilters } from '#lib/server/tasks/validation';
import { openLocalD1 } from '../helpers/d1';
import {
	archive,
	assignedNotifications,
	clearAll,
	seedProject,
	seedTask,
	taskDefaults,
	taskRow
} from '../helpers/seed-tasks';
import { insertUser } from '../helpers/users';

/** RB-01 repo functions against a local D1: numbering, guards, moves, notifications, filters. */

let db: Db;
let dispose: () => Promise<void>;
beforeAll(async () => {
	const opened = await openLocalD1();
	db = getDb(opened.db);
	dispose = opened.dispose;
});
afterAll(() => dispose());
beforeEach(() => clearAll(db));

const noFilters = parseFilters(new URLSearchParams());

describe('projects', () => {
	it('stores the key, refuses a duplicate as a field error and an inactive lead', async () => {
		const admin = await insertUser(db, { role: 'admin' });
		const off = await insertUser(db, { status: 'disabled' });
		const base = { name: 'Operations', description: '', leadId: null };
		expect(await createProject(db, admin, { ...base, key: 'OPS' }, 1)).toEqual({ ok: true });
		expect(await createProject(db, admin, { ...base, key: 'OPS' }, 2)).toMatchObject({
			ok: false,
			errors: { key: 'That key is already used' }
		});
		expect(
			await createProject(db, admin, { ...base, key: 'OFF', leadId: off.id }, 3)
		).toMatchObject({ ok: false, errors: { leadId: expect.any(String) } });
		expect((await getProjectByKey(db, 'OPS'))?.name).toBe('Operations');
		expect(await getProjectByKey(db, 'OFF')).toBeNull();
	});

	it('edit and archive: version guard, manage rights in SQL, a kept disabled lead', async () => {
		const admin = await insertUser(db, { role: 'admin' });
		const lead = await insertUser(db);
		const other = await insertUser(db);
		const p = await seedProject(db, admin, { leadId: lead.id }, 10);
		const fields = { name: 'Renamed', description: 'x', leadId: lead.id };
		expect(await updateProject(db, other, p.id, fields, p.updatedAt, 20)).toMatchObject({
			reason: 'forbidden'
		});
		expect(await updateProject(db, lead, p.id, fields, p.updatedAt - 1, 20)).toMatchObject({
			reason: 'conflict'
		});
		expect(await updateProject(db, lead, p.id, fields, p.updatedAt, 20)).toEqual({ ok: true });
		await db.update(users).set({ status: 'disabled' }).where(eq(users.id, lead.id));
		const after = await getProjectByKey(db, p.key);
		expect(
			await updateProject(db, admin, p.id, { ...fields, name: 'Again' }, after!.updatedAt, 30)
		).toEqual({ ok: true });
		const v = (await getProjectByKey(db, p.key))!;
		expect(await setProjectArchived(db, admin, p.id, true, v.updatedAt, 40)).toEqual({ ok: true });
		expect(await listProjects(db, { archived: true })).toHaveLength(1);
		expect(await listProjects(db, { archived: false })).toHaveLength(0);
	});

	it('counts open tasks per project, closed and deleted excluded', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		const q = await seedProject(db, u);
		await seedTask(db, u, p);
		await seedTask(db, u, p, { status: 'done' });
		const gone = await seedTask(db, u, p);
		await deleteTask(db, p, gone.id, Date.now());
		const counts = await projectOpenCounts(db, [p.id, q.id]);
		expect(counts.get(p.id)).toBe(1);
		expect(counts.get(q.id)).toBeUndefined();
		// 150 ids are bound once as JSON, not as 150 parameters.
		const many = Array.from(
			{ length: 150 },
			(_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
		);
		expect((await projectOpenCounts(db, [...many, p.id])).get(p.id)).toBe(1);
	});
});

describe('task create', () => {
	it('numbers consecutively and bumps the counter in the same batch', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		const a = await seedTask(db, u, p);
		const b = await seedTask(db, u, p);
		expect([a.number, b.number]).toEqual([1, 2]);
		const row = await db.select().from(projects).where(eq(projects.id, p.id)).get();
		expect(row?.nextTaskNumber).toBe(3);
	});

	it('20 concurrent creates get 1..20, no gap, no duplicate (checklist probe; PRD asks 10)', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				createTask(db, u, p, taskDefaults({ title: `Race ${i}` }), Date.now())
			)
		);
		const numbers = results.map((r) => (r.ok ? r.number : -1)).sort((x, y) => x - y);
		expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
		const row = await db.select().from(projects).where(eq(projects.id, p.id)).get();
		expect(row?.nextTaskNumber).toBe(21);
	});

	it('an archived or missing project inserts nothing', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		await archive(db, p.id);
		expect(await createTask(db, u, p, taskDefaults(), 1)).toEqual({
			ok: false,
			reason: 'archived'
		});
		expect(
			await createTask(db, u, { id: '00000000-0000-4000-8000-000000000000' }, taskDefaults(), 1)
		).toEqual({ ok: false, reason: 'not_found' });
		const count = await db
			.select({ n: sql<number>`count(*)` })
			.from(tasks)
			.get();
		expect(count?.n).toBe(0);
	});

	it('numbers are not reused after a soft delete', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		const a = await seedTask(db, u, p);
		await deleteTask(db, p, a.id, Date.now());
		expect((await seedTask(db, u, p)).number).toBe(2);
		expect(await getTaskByNumber(db, p.id, 1)).toBeNull();
	});
});

describe('assigned notifications', () => {
	it('create: another active user gets one; self gets none; disabled is refused', async () => {
		const actor = await insertUser(db);
		const mate = await insertUser(db);
		const off = await insertUser(db, { status: 'disabled' });
		const p = await seedProject(db, actor);
		await seedTask(db, actor, p, { assigneeId: mate.id });
		await seedTask(db, actor, p, { assigneeId: actor.id });
		expect(await createTask(db, actor, p, taskDefaults({ assigneeId: off.id }), 1)).toMatchObject({
			ok: false,
			reason: 'invalid',
			errors: { assigneeId: expect.any(String) }
		});
		const rows = await assignedNotifications(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			userId: mate.id,
			actorId: actor.id,
			kind: 'assigned',
			targetKind: 'task',
			commentId: null,
			readAt: null
		});
		const count = await db
			.select({ n: sql<number>`count(*)` })
			.from(tasks)
			.get();
		expect(count?.n).toBe(2);
	});

	it('reassign A→B→A: one unread row per person and task (L2); read, then reassigned, notifies again; unassign, no change, self and move do not', async () => {
		const actor = await insertUser(db);
		const a = await insertUser(db);
		const b = await insertUser(db);
		const p = await seedProject(db, actor);
		const t = await seedTask(db, actor, p);
		const step = async (assigneeId: string | null) => {
			const row = (await taskRow(db, t.id))!;
			return patchTask(
				db,
				actor,
				p,
				row,
				'assigneeId',
				assigneeId,
				row.updatedAt,
				row.updatedAt + 5
			);
		};
		await step(a.id);
		await step(b.id);
		await step(a.id);
		await step(a.id); // unchanged
		await step(null);
		await step(actor.id);
		await moveTask(db, p, t.id, 'done', { place: 'top' }, Date.now());
		expect((await assignedNotifications(db, a.id)).length).toBe(1);
		// Once A has read it, a new assignment notifies A again.
		await db
			.update(notifications)
			.set({ readAt: Date.now() })
			.where(eq(notifications.userId, a.id));
		await step(b.id);
		await step(a.id);
		expect((await assignedNotifications(db, a.id)).length).toBe(2);
		expect((await assignedNotifications(db, a.id)).filter((n) => n.readAt === null)).toHaveLength(
			1
		);
		expect((await assignedNotifications(db, b.id)).length).toBe(1);
		expect((await assignedNotifications(db, actor.id)).length).toBe(0);
	});

	it('a refused (stale) write leaves no notification', async () => {
		const actor = await insertUser(db);
		const mate = await insertUser(db);
		const p = await seedProject(db, actor);
		const t = await seedTask(db, actor, p);
		const row = (await taskRow(db, t.id))!;
		const result = await patchTask(db, actor, p, row, 'assigneeId', mate.id, row.updatedAt - 1, 99);
		expect(result).toMatchObject({ ok: false, reason: 'conflict' });
		expect(await assignedNotifications(db)).toHaveLength(0);
		expect((await taskRow(db, t.id))?.assigneeId).toBeNull();
	});
});

describe('task update', () => {
	it('stale version: conflict with the current task, nothing changed; fresh version succeeds', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		const t = await seedTask(db, u, p, { title: 'Before' }, 100);
		const row = (await taskRow(db, t.id))!;
		expect(await patchTask(db, u, p, row, 'title', 'Theirs', 100, 200)).toEqual({ ok: true });
		const mine = await updateTask(db, u, p, row, { ...taskDefaults(), title: 'Mine' }, 100, 300);
		expect(mine).toMatchObject({ ok: false, reason: 'conflict', current: { title: 'Theirs' } });
		expect((await taskRow(db, t.id))?.title).toBe('Theirs');
		const current = (mine as { current: { updatedAt: number } }).current;
		expect(
			await updateTask(db, u, p, row, { ...taskDefaults(), title: 'Mine' }, current.updatedAt, 300)
		).toEqual({ ok: true });
		expect((await taskRow(db, t.id))?.title).toBe('Mine');
	});

	it('updated_at always grows, even when the clock is behind', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		const t = await seedTask(db, u, p, {}, 5_000);
		const row = (await taskRow(db, t.id))!;
		await patchTask(db, u, p, row, 'priority', 'high', 5_000, 1_000);
		expect((await taskRow(db, t.id))?.updatedAt).toBe(5_001);
	});

	it('keeps an unchanged disabled assignee; refuses a new disabled one', async () => {
		const u = await insertUser(db);
		const gone = await insertUser(db);
		const p = await seedProject(db, u);
		const t = await seedTask(db, u, p, { assigneeId: gone.id });
		await db.update(users).set({ status: 'disabled' }).where(eq(users.id, gone.id));
		let row = (await taskRow(db, t.id))!;
		const fields = { ...taskDefaults({ assigneeId: gone.id }), title: 'Kept' };
		expect(await updateTask(db, u, p, row, fields, row.updatedAt, Date.now())).toEqual({
			ok: true
		});
		const other = await insertUser(db, { status: 'disabled' });
		row = (await taskRow(db, t.id))!;
		expect(
			await patchTask(db, u, p, row, 'assigneeId', other.id, row.updatedAt, Date.now())
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('archived project and deleted task refuse every write', async () => {
		const u = await insertUser(db, { role: 'admin' });
		const p = await seedProject(db, u);
		const t = await seedTask(db, u, p);
		const row = (await taskRow(db, t.id))!;
		await archive(db, p.id);
		expect(await patchTask(db, u, p, row, 'title', 'X', row.updatedAt, 1)).toEqual({
			ok: false,
			reason: 'archived'
		});
		expect(await moveTask(db, p, t.id, 'done', { place: 'top' }, 1)).toEqual({
			ok: false,
			reason: 'archived'
		});
		expect(await deleteTask(db, p, t.id, 1)).toEqual({ ok: false, reason: 'archived' });
		expect((await taskRow(db, t.id))?.title).toBe(row.title);
		await db.update(projects).set({ status: 'active' }).where(eq(projects.id, p.id));
		await deleteTask(db, p, t.id, 2);
		expect(await patchTask(db, u, p, row, 'title', 'X', row.updatedAt, 3)).toEqual({
			ok: false,
			reason: 'not_found'
		});
		expect(await deleteTask(db, p, t.id, 4)).toEqual({ ok: true });
	});
});

describe('completed_at and moves', () => {
	it('done sets it, done→canceled keeps it, reopening clears it', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		const t = await seedTask(db, u, p);
		await moveTask(db, p, t.id, 'done', { place: 'bottom' }, 1_000);
		expect((await taskRow(db, t.id))?.completedAt).toBe(1_000);
		await moveTask(db, p, t.id, 'canceled', { place: 'bottom' }, 2_000);
		expect((await taskRow(db, t.id))?.completedAt).toBe(1_000);
		await moveTask(db, p, t.id, 'todo', { place: 'bottom' }, 3_000);
		expect((await taskRow(db, t.id))?.completedAt).toBeNull();
		const row = (await taskRow(db, t.id))!;
		await patchTask(db, u, p, row, 'status', 'done', row.updatedAt, 4_000);
		expect((await taskRow(db, t.id))?.completedAt).toBe(4_000);
	});

	it('between two cards lands strictly between; top and bottom; foreign anchors go to the bottom', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		const other = await seedProject(db, u);
		const [a, b, c] = [
			await seedTask(db, u, p),
			await seedTask(db, u, p),
			await seedTask(db, u, p)
		];
		const foreign = await seedTask(db, u, other);
		const elsewhere = await seedTask(db, u, p, { status: 'backlog' });
		const pos = async (id: string) => (await taskRow(db, id))!.position;
		const [pa, pb] = [await pos(a.id), await pos(b.id)];
		await moveTask(db, p, c.id, 'todo', { after: a.id }, Date.now());
		expect(await pos(c.id)).toBeGreaterThan(pa);
		expect(await pos(c.id)).toBeLessThan(pb);
		await moveTask(db, p, b.id, 'todo', { after: null }, Date.now());
		expect(await pos(b.id)).toBeLessThan(pa);
		for (const anchor of [foreign.id, elsewhere.id, '00000000-0000-4000-8000-000000000000']) {
			await moveTask(db, p, a.id, 'todo', { after: anchor }, Date.now());
			const column = await boardTasks(
				db,
				p.id,
				parseFilters(new URLSearchParams('status=todo')),
				u.id
			);
			expect(column[0]?.tasks.at(-1)?.id).toBe(a.id);
		}
		expect(await moveTask(db, other, a.id, 'todo', { place: 'top' }, 1)).toEqual({
			ok: false,
			reason: 'not_found'
		});
	});

	it('renumbers a column whose gap is below 1e-6 and keeps the order', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		const ids = [];
		for (let i = 0; i < 4; i++) ids.push((await seedTask(db, u, p)).id);
		const [a, b, c, d] = ids as [string, string, string, string];
		await db.update(tasks).set({ position: 1 }).where(eq(tasks.id, a));
		await db
			.update(tasks)
			.set({ position: 1 + 1e-7 })
			.where(eq(tasks.id, b));
		await db
			.update(tasks)
			.set({ position: 1 + 2e-7 })
			.where(eq(tasks.id, c));
		await moveTask(db, p, d, 'todo', { after: a }, Date.now());
		const [column] = await boardTasks(
			db,
			p.id,
			parseFilters(new URLSearchParams('status=todo')),
			u.id
		);
		expect(column?.tasks.map((t) => t.id)).toEqual([a, d, b, c]);
		const positions = column!.tasks.map((t) => t.position);
		for (let i = 1; i < positions.length; i++)
			expect(positions[i]! - positions[i - 1]!).toBeGreaterThan(1);
	});

	it('renumber leaves an archived project frozen (L4)', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		const a = await seedTask(db, u, p);
		await db.update(tasks).set({ position: 7.5 }).where(eq(tasks.id, a.id));
		await archive(db, p.id);
		await renumberColumn(db, p.id, 'todo');
		expect((await taskRow(db, a.id))?.position).toBe(7.5);
		await db.update(projects).set({ status: 'active' }).where(eq(projects.id, p.id));
		await renumberColumn(db, p.id, 'todo');
		expect((await taskRow(db, a.id))?.position).toBe(1024);
	});

	it('board: six columns in order, 100 cards per column and the full count', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		const at = Date.now();
		const rows = Array.from({ length: 105 }, (_, i) => ({
			id: crypto.randomUUID(),
			projectId: p.id,
			number: i + 1,
			title: `Bulk ${i}`,
			status: 'backlog' as const,
			position: (i + 1) * 1024,
			createdBy: u.id,
			createdAt: at,
			updatedAt: at
		}));
		for (let i = 0; i < rows.length; i += 5) await db.insert(tasks).values(rows.slice(i, i + 5));
		const board = await boardTasks(db, p.id, noFilters, u.id);
		expect(board.map((c) => c.status)).toEqual([
			'backlog',
			'todo',
			'in_progress',
			'in_review',
			'done',
			'canceled'
		]);
		expect(board[0]?.count).toBe(105);
		expect(board[0]?.tasks).toHaveLength(100);
		expect(board[0]?.tasks[0]?.number).toBe(1);
	});
});

describe('list and my tasks', () => {
	it('filters: OR within one, AND across; me/none/user; pagination and total', async () => {
		const u = await insertUser(db);
		const mate = await insertUser(db);
		const p = await seedProject(db, u);
		await seedTask(db, u, p, { status: 'todo', priority: 'high', assigneeId: u.id });
		await seedTask(db, u, p, { status: 'done', priority: 'high', assigneeId: mate.id });
		await seedTask(db, u, p, { status: 'todo', priority: 'low' });
		const q = (s: string) =>
			listTasks(
				db,
				p.id,
				parseFilters(new URLSearchParams(s)),
				{ sort: 'number', dir: 'asc' },
				1,
				u.id
			);
		expect((await q('status=todo&status=done')).total).toBe(3);
		expect((await q('status=todo&priority=high')).rows.map((r) => r.number)).toEqual([1]);
		expect((await q('assignee=me')).rows.map((r) => r.number)).toEqual([1]);
		expect((await q('assignee=none')).rows.map((r) => r.number)).toEqual([3]);
		expect((await q(`assignee=${mate.id}`)).rows.map((r) => r.number)).toEqual([2]);
		expect((await q('status=bogus&priority=nope')).total).toBe(3);
		for (let i = 0; i < 52; i++) await seedTask(db, u, p);
		const page2 = await listTasks(db, p.id, noFilters, { sort: 'number', dir: 'desc' }, 2, u.id);
		expect(page2.total).toBe(55);
		expect(page2.rows).toHaveLength(5);
		expect(page2.rows[0]?.number).toBe(5);
		const byPriority = await listTasks(
			db,
			p.id,
			noFilters,
			{ sort: 'priority', dir: 'desc' },
			1,
			u.id
		);
		expect(byPriority.rows.slice(0, 2).map((r) => r.priority)).toEqual(['high', 'high']);
	});

	it('my tasks: only mine, live, grouped by the team date; closed only on request', async () => {
		const u = await insertUser(db);
		const mate = await insertUser(db);
		const p = await seedProject(db, u);
		const archived = await seedProject(db, u);
		await seedTask(db, u, p, { assigneeId: u.id, dueOn: '2026-10-25', priority: 'low' });
		await seedTask(db, u, p, { assigneeId: u.id, dueOn: '2026-10-25', priority: 'urgent' });
		await seedTask(db, u, p, { assigneeId: u.id, dueOn: '2026-10-26' });
		await seedTask(db, u, p, { assigneeId: u.id, dueOn: '2026-11-01' });
		await seedTask(db, u, archived, { assigneeId: u.id });
		await seedTask(db, u, p, { assigneeId: u.id, status: 'done' });
		await seedTask(db, u, p, { assigneeId: mate.id });
		const gone = await seedTask(db, u, p, { assigneeId: u.id });
		await deleteTask(db, p, gone.id, Date.now());
		await archive(db, archived.id);
		const mine = await listMyTasks(db, u.id, { closed: false }, '2026-10-26');
		expect(mine.groups.overdue.map((t) => t.priority)).toEqual(['urgent', 'low']);
		expect(mine.groups.today).toHaveLength(1);
		expect(mine.groups.upcoming).toHaveLength(1);
		expect(mine.groups.none).toHaveLength(1);
		expect(mine.groups.none[0]?.projectStatus).toBe('archived');
		expect(mine.closed).toHaveLength(0);
		expect((await listMyTasks(db, u.id, { closed: true }, '2026-10-26')).closed).toHaveLength(1);
	});
});
