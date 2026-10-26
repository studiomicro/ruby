import { isHttpError, isRedirect } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { render } from 'svelte/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { labels, milestones, savedViews, taskChecklistItems, tasks } from '#lib/server/db/schema';
import { bulkUpdate } from '#lib/server/pm/bulk';
import {
	addItem,
	deleteItem,
	editItem,
	listItems,
	moveItem,
	toggleItem
} from '#lib/server/pm/checklist';
import { getColumns, saveColumns } from '#lib/server/pm/columns';
import { taskExtras } from '#lib/server/pm/extras';
import {
	createLabel,
	deleteLabel,
	listLabels,
	setTaskLabels,
	updateLabel
} from '#lib/server/pm/labels';
import {
	createMilestone,
	deleteMilestone,
	milestoneProgress,
	setMilestoneStatus,
	updateMilestone
} from '#lib/server/pm/milestones';
import { labelNameKey, parseColumns } from '#lib/server/pm/validation';
import { saveView } from '#lib/server/pm/views';
import { searchAll } from '#lib/server/search/repo';
import { boardTasks, listTasks, moveTask, patchTask } from '#lib/server/tasks/repo';
import { parseFilters } from '#lib/server/tasks/validation';
import { applyMigration, openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import {
	archive,
	assignedNotifications,
	clearAll,
	seedProject,
	seedTask,
	taskRow
} from '../helpers/seed-tasks';
import { insertUser } from '../helpers/users';
import LabelChip from '../../src/lib/ui/pm/LabelChip.svelte';

/**
 * RB-08 against local D1: labels, checklists, milestones, board columns and WIP, saved views and bulk edit, through
 * the repos and the route loads/actions. Limits and races, permissions, archived projects, the 100-parameter rule,
 * query counts, FTS isolation and the migration on a database with existing tasks. Fictional data only.
 */

const binding: { DB?: D1Database; TEAM_TIME_ZONE: string } = { TEAM_TIME_ZONE: 'Asia/Jakarta' };
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const layout = await import('../../src/routes/(app)/projects/[key]/+layout.server');
const view = await import('../../src/routes/(app)/projects/[key]/+page.server');
const settings = await import('../../src/routes/(app)/projects/[key]/settings/+page.server');
const detail = await import('../../src/routes/(app)/projects/[key]/tasks/[number]/+page.server');
const milestonePage =
	await import('../../src/routes/(app)/projects/[key]/milestones/[id]/+page.server');
const openView = await import('../../src/routes/(app)/projects/[key]/views/[id]/+server');
const myTasks = await import('../../src/routes/(app)/my-tasks/+page.server');

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

const NONE = '00000000-0000-4000-8000-000000000000';
const noFilters = parseFilters(new URLSearchParams());

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

/** A request as `user` to `path`, with the layout's data as `parent()`. */
async function req(
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

/** Two users, a project OPS led by `lead` and a second project OTHER. */
async function world() {
	const admin = await insertUser(db, { role: 'admin', name: 'Ada Admin' });
	const lead = await insertUser(db, { name: 'Lee Lead' });
	const member = await insertUser(db, { name: 'Mia Member' });
	const ops = await seedProject(db, admin, { key: 'OPS', leadId: lead.id });
	const other = await seedProject(db, admin, { key: 'OTHER' });
	return { admin, lead, member, ops, other };
}

const label = async (
	projectId: string,
	actor: SessionUser,
	name: string,
	color = 'red' as const
) => {
	const r = await createLabel(
		db,
		actor,
		projectId,
		{ name, nameKey: labelNameKey(name), color },
		Date.now()
	);
	if (!r.ok) throw new Error(`label: ${r.reason}`);
	return r.id;
};
const milestone = async (projectId: string, actor: SessionUser, name = 'Beta') => {
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

// ── Access ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('access', () => {
	it('every new load and action refuses a signed-out request with 401 and writes nothing', async () => {
		const w = await world();
		const t = await seedTask(db, w.admin, w.ops);
		const m = await milestone(w.ops.id, w.admin);
		const params = { key: 'OPS', number: '1', id: m };
		const calls: [unknown, string, boolean][] = [
			[view.actions.bulk, '/projects/OPS', true],
			[view.actions.viewSave, '/projects/OPS', true],
			[view.actions.viewDelete, '/projects/OPS', true],
			[settings.actions.labelSave, '/projects/OPS/settings', true],
			[settings.actions.labelDelete, '/projects/OPS/settings', true],
			[settings.actions.milestoneSave, '/projects/OPS/settings', true],
			[settings.actions.milestoneStatus, '/projects/OPS/settings', true],
			[settings.actions.milestoneDelete, '/projects/OPS/settings', true],
			[settings.actions.columnsSave, '/projects/OPS/settings', true],
			[detail.actions.labelsSet, '/projects/OPS/tasks/1', true],
			[detail.actions.checkAdd, '/projects/OPS/tasks/1', true],
			[detail.actions.checkToggle, '/projects/OPS/tasks/1', true],
			[detail.actions.checkEdit, '/projects/OPS/tasks/1', true],
			[detail.actions.checkDelete, '/projects/OPS/tasks/1', true],
			[detail.actions.checkMove, '/projects/OPS/tasks/1', true],
			[milestonePage.load, `/projects/OPS/milestones/${m}`, false],
			[openView.GET, `/projects/OPS/views/${NONE}`, false]
		];
		const form = { name: 'x', color: 'red', text: 'x', taskId: t.id, status: 'done' };
		for (const [fn, path, post] of calls) {
			const r = await run(fn, await req(null, path, { params, form: post ? form : undefined }));
			expect(status(r), path).toBe(401);
		}
		expect(await db.select().from(labels)).toHaveLength(0);
		expect(await db.select().from(taskChecklistItems)).toHaveLength(0);
		expect((await taskRow(db, t.id))?.status).toBe('todo');
	});

	it('manager-only actions: a member gets 403 and nothing changes; the lead and an admin may', async () => {
		const w = await world();
		const m = await milestone(w.ops.id, w.lead);
		const l = await label(w.ops.id, w.member, 'Bug');
		const before = await db.select().from(milestones).where(eq(milestones.id, m)).get();
		const asMember = async (fn: unknown, form: Record<string, string>) =>
			status(
				await run(
					fn,
					await req(w.member, '/projects/OPS/settings', { params: { key: 'OPS' }, form })
				)
			);
		expect(await asMember(settings.actions.milestoneSave, { name: 'New' })).toBe(403);
		expect(
			await asMember(settings.actions.milestoneSave, {
				id: m,
				name: 'Renamed',
				expectedUpdatedAt: String(before!.updatedAt)
			})
		).toBe(403);
		expect(
			await asMember(settings.actions.milestoneStatus, {
				id: m,
				status: 'closed',
				expectedUpdatedAt: String(before!.updatedAt)
			})
		).toBe(403);
		expect(await asMember(settings.actions.milestoneDelete, { id: m })).toBe(403);
		expect(await asMember(settings.actions.columnsSave, { expectedUpdatedAt: '0' })).toBe(403);
		expect(await asMember(settings.actions.labelDelete, { id: l })).toBe(403);
		expect(
			await asMember(settings.actions.labelSave, {
				id: l,
				name: 'Bugs',
				color: 'blue',
				expectedUpdatedAt: '0'
			})
		).toBe(403);
		expect(await db.select().from(milestones)).toEqual([before]);
		expect((await listLabels(db, w.ops.id)).map((x) => x.name)).toEqual(['Bug']);
		// Any member may create a label.
		expect(await asMember(settings.actions.labelSave, { name: 'Docs', color: 'blue' })).toBe(200);
		// The lead and an admin may manage.
		for (const who of [w.lead, w.admin]) {
			const r = await run(
				settings.actions.milestoneSave,
				await req(who, '/projects/OPS/settings', {
					params: { key: 'OPS' },
					form: { name: `By ${who.name}` }
				})
			);
			expect(pm(r)).toMatchObject({ ok: true });
		}
	});

	it('ids of another project are not found, never accepted', async () => {
		const w = await world();
		const foreignLabel = await label(w.other.id, w.admin, 'Elsewhere');
		const foreignMilestone = await milestone(w.other.id, w.admin);
		const t = await seedTask(db, w.admin, w.ops);
		const del = await run(
			settings.actions.labelDelete,
			await req(w.admin, '/projects/OPS/settings', {
				params: { key: 'OPS' },
				form: { id: foreignLabel }
			})
		);
		expect(status(del)).toBe(404);
		const ms = await run(
			milestonePage.load,
			await req(w.admin, `/projects/OPS/milestones/${foreignMilestone}`, {
				params: { key: 'OPS', id: foreignMilestone }
			})
		);
		expect(status(ms)).toBe(404);
		const missing = await run(
			milestonePage.load,
			await req(w.admin, `/projects/OPS/milestones/${NONE}`, { params: { key: 'OPS', id: NONE } })
		);
		expect(status(missing)).toBe(404);
		expect((ms as { body: unknown }).body).toEqual((missing as { body: unknown }).body);
		expect((await setTaskLabels(db, w.ops.id, t.id, [foreignLabel], 1)).ok).toBe(false);
		expect(
			(await db.select().from(labels).where(eq(labels.id, foreignLabel)).get())?.deletedAt
		).toBeNull();
	});
});

// ── Labels ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('labels', () => {
	it('case-insensitive per project, 30 per project, delete frees the name', async () => {
		const w = await world();
		await label(w.ops.id, w.member, 'Bug');
		const dup = await createLabel(
			db,
			w.member,
			w.ops.id,
			{ name: 'bug', nameKey: 'bug', color: 'blue' },
			1
		);
		expect(dup).toMatchObject({ ok: false, reason: 'duplicate' });
		await label(w.other.id, w.member, 'Bug');
		for (let i = 2; i <= 30; i++) await label(w.ops.id, w.member, `L${i}`);
		const over = await createLabel(
			db,
			w.member,
			w.ops.id,
			{ name: 'L31', nameKey: 'l31', color: 'red' },
			1
		);
		expect(over).toMatchObject({ ok: false, reason: 'limit' });
		const bug = (await listLabels(db, w.ops.id)).find((l) => l.name === 'Bug')!;
		expect((await deleteLabel(db, w.admin, w.ops.id, bug.id, 2)).ok).toBe(true);
		expect((await deleteLabel(db, w.admin, w.ops.id, bug.id, 3)).ok).toBe(true);
		expect(
			(await createLabel(db, w.member, w.ops.id, { name: 'BUG', nameKey: 'bug', color: 'red' }, 4))
				.ok
		).toBe(true);
	});

	it('20 concurrent creates against 29 live labels: exactly one succeeds', async () => {
		const w = await world();
		for (let i = 1; i <= 29; i++) await label(w.ops.id, w.member, `L${i}`);
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				createLabel(
					db,
					w.member,
					w.ops.id,
					{ name: `Race ${i}`, nameKey: `race ${i}`, color: 'red' },
					1
				)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(await listLabels(db, w.ops.id)).toHaveLength(30);
	});

	it('the route refuses a 31-char name, a colour outside the enum and a duplicate with field errors', async () => {
		const w = await world();
		const post = async (form: Record<string, string>) =>
			run(
				settings.actions.labelSave,
				await req(w.member, '/projects/OPS/settings', { params: { key: 'OPS' }, form })
			);
		expect(pm(await post({ name: 'x'.repeat(31), color: 'red' })).errors?.name).toContain('30');
		expect(pm(await post({ name: 'Bug', color: 'teal' })).errors?.color).toBeTruthy();
		expect(pm(await post({ name: 'Bug', color: 'red' })).ok).toBe(true);
		const dup = await post({ name: 'BUG', color: 'red' });
		expect(status(dup)).toBe(400);
		expect(pm(dup).message).toBe('This project already has a label with that name.');
	});

	it('a task holds at most 10; a deleted or foreign label is refused with nothing changed', async () => {
		const w = await world();
		const t = await seedTask(db, w.admin, w.ops);
		const ids = [];
		for (let i = 0; i < 11; i++) ids.push(await label(w.ops.id, w.member, `L${i}`));
		expect((await setTaskLabels(db, w.ops.id, t.id, ids.slice(0, 10), 1)).ok).toBe(true);
		expect(await setTaskLabels(db, w.ops.id, t.id, ids, 2)).toMatchObject({
			ok: false,
			reason: 'limit'
		});
		const before = (await taskExtras(db, w.ops.id, [t.id]))
			.get(t.id)!
			.labels.map((l) => l.id)
			.sort();
		expect(before).toEqual(ids.slice(0, 10).sort());
		const foreign = await label(w.other.id, w.member, 'Foreign');
		expect(await setTaskLabels(db, w.ops.id, t.id, [ids[0]!, foreign], 3)).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
		await deleteLabel(db, w.admin, w.ops.id, ids[10]!, 4);
		expect(await setTaskLabels(db, w.ops.id, t.id, [ids[10]!], 5)).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
		const after = (await taskExtras(db, w.ops.id, [t.id]))
			.get(t.id)!
			.labels.map((l) => l.id)
			.sort();
		expect(after).toEqual(before);
		// Labels never bump the task's version.
		const row = await taskRow(db, t.id);
		expect((await setTaskLabels(db, w.ops.id, t.id, [ids[1]!], 6)).ok).toBe(true);
		expect((await taskRow(db, t.id))?.updatedAt).toBe(row?.updatedAt);
		// A deleted label leaves cards and filters.
		await deleteLabel(db, w.admin, w.ops.id, ids[1]!, 7);
		expect((await taskExtras(db, w.ops.id, [t.id])).get(t.id)!.labels).toEqual([]);
		const f = { ...noFilters, labels: [ids[1]!] };
		expect(
			(await listTasks(db, w.ops.id, f, { sort: 'number', dir: 'desc' }, 1, w.admin.id)).total
		).toBe(0);
	});
});

// ── Checklist ───────────────────────────────────────────────────────────────────────────────────────────────

describe('checklist', () => {
	it('add, tick, untick, edit, move, delete; progress 3/7 everywhere', async () => {
		const w = await world();
		const t = await seedTask(db, w.admin, w.ops);
		const ids: string[] = [];
		for (let i = 1; i <= 7; i++) {
			const r = await addItem(db, w.member, w.ops.id, t.id, `Step ${i}`, i);
			if (!r.ok) throw new Error('add');
			ids.push(r.id);
		}
		for (const id of ids.slice(0, 4))
			expect((await toggleItem(db, w.member, w.ops.id, t.id, id, true, 10)).ok).toBe(true);
		expect((await toggleItem(db, w.member, w.ops.id, t.id, ids[3]!, false, 11)).ok).toBe(true);
		const extras = await taskExtras(db, w.ops.id, [t.id]);
		expect(extras.get(t.id)?.checklist).toEqual({ done: 3, total: 7 });
		const items = await listItems(db, t.id);
		const second = items[1]!;
		expect(
			(await editItem(db, w.ops.id, t.id, second.id, 'Renamed', second.updatedAt, 20)).ok
		).toBe(true);
		expect(
			await editItem(db, w.ops.id, t.id, second.id, 'Stale', second.updatedAt, 21)
		).toMatchObject({
			ok: false,
			reason: 'conflict'
		});
		expect((await moveItem(db, w.ops.id, t.id, ids[6]!, 'up', 30)).ok).toBe(true);
		expect((await moveItem(db, w.ops.id, t.id, ids[0]!, 'up', 31)).ok).toBe(true);
		expect((await listItems(db, t.id)).map((i) => i.text)).toEqual([
			'Step 1',
			'Renamed',
			'Step 3',
			'Step 4',
			'Step 5',
			'Step 7',
			'Step 6'
		]);
		expect((await moveItem(db, w.ops.id, t.id, ids[0]!, 'down', 32)).ok).toBe(true);
		expect((await listItems(db, t.id))[1]?.text).toBe('Step 1');
		expect((await deleteItem(db, w.ops.id, t.id, ids[4]!, 40)).ok).toBe(true);
		expect((await deleteItem(db, w.ops.id, t.id, ids[4]!, 41)).ok).toBe(true);
		expect(await listItems(db, t.id)).toHaveLength(6);
		// The list rows, the board cards and My tasks carry it.
		const listed = await run(
			view.load,
			await req(w.admin, '/projects/OPS', { params: { key: 'OPS' } })
		);
		expect(
			(listed as { list: { rows: { checklist: unknown }[] } }).list.rows[0]?.checklist
		).toEqual({
			done: 3,
			total: 6
		});
	});

	it('the 51st step is refused; 20 concurrent adds against 49 live: exactly one succeeds', async () => {
		const w = await world();
		const t = await seedTask(db, w.admin, w.ops);
		for (let i = 0; i < 49; i++) await addItem(db, w.member, w.ops.id, t.id, `s${i}`, i);
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				addItem(db, w.member, w.ops.id, t.id, `race ${i}`, 100 + i)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(await listItems(db, t.id)).toHaveLength(50);
		expect(await addItem(db, w.member, w.ops.id, t.id, 'one more', 200)).toMatchObject({
			ok: false,
			reason: 'limit'
		});
	});

	it('ticking does not change tasks.updated_at and does not cause a 409 on an open edit form', async () => {
		const w = await world();
		const t = await seedTask(db, w.admin, w.ops);
		const opened = (await taskRow(db, t.id))!;
		const add = await run(
			detail.actions.checkAdd,
			await req(w.member, '/projects/OPS/tasks/1', {
				params: { key: 'OPS', number: '1' },
				form: { text: 'Write it' }
			})
		);
		expect(pm(add).ok).toBe(true);
		const tick = await run(
			detail.actions.checkToggle,
			await req(w.member, '/projects/OPS/tasks/1', {
				params: { key: 'OPS', number: '1' },
				form: { id: pm(add).id!, done: '1' }
			})
		);
		expect(pm(tick)).toMatchObject({ ok: true, message: 'Step done.' });
		expect((await taskRow(db, t.id))?.updatedAt).toBe(opened.updatedAt);
		const r = await patchTask(
			db,
			w.admin,
			w.ops,
			{ id: t.id, assigneeId: null },
			'title',
			'Edited',
			opened.updatedAt,
			Date.now()
		);
		expect(r.ok).toBe(true);
		const tooLong = await run(
			detail.actions.checkAdd,
			await req(w.member, '/projects/OPS/tasks/1', {
				params: { key: 'OPS', number: '1' },
				form: { text: 'x'.repeat(201) }
			})
		);
		expect(status(tooLong)).toBe(400);
	});

	it('a step of another task is not found; the task URL decides', async () => {
		const w = await world();
		const a = await seedTask(db, w.admin, w.ops);
		const b = await seedTask(db, w.admin, w.ops);
		const added = await addItem(db, w.member, w.ops.id, a.id, 'Only on A', 1);
		if (!added.ok) throw new Error('add');
		expect(await toggleItem(db, w.member, w.ops.id, b.id, added.id, true, 2)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
		expect((await listItems(db, a.id))[0]?.done).toBe(false);
	});
});

// ── Milestones ──────────────────────────────────────────────────────────────────────────────────────────────

describe('manager rule inside the write (red team L1)', () => {
	it('a non-manager actor reaching the repo directly is refused as forbidden and nothing changes', async () => {
		const w = await world();
		const l = await label(w.ops.id, w.member, 'Bug');
		const m = await milestone(w.ops.id, w.lead);
		const lb = (await db.select().from(labels).where(eq(labels.id, l)).get())!;
		const mb = (await db.select().from(milestones).where(eq(milestones.id, m)).get())!;
		const input = { name: 'Renamed', nameKey: 'renamed', color: 'blue' as const };
		const forbidden = { ok: false, reason: 'forbidden' };
		expect(await updateLabel(db, w.member, w.ops.id, l, input, lb.updatedAt, 10)).toMatchObject(
			forbidden
		);
		expect(await deleteLabel(db, w.member, w.ops.id, l, 10)).toMatchObject(forbidden);
		const ms = { name: 'X', description: '', dueOn: null };
		expect(await updateMilestone(db, w.member, w.ops.id, m, ms, mb.updatedAt, 10)).toMatchObject(
			forbidden
		);
		expect(
			await setMilestoneStatus(db, w.member, w.ops.id, m, 'closed', mb.updatedAt, 10)
		).toMatchObject(forbidden);
		expect(await deleteMilestone(db, w.member, w.ops.id, m, 10)).toMatchObject(forbidden);
		expect(await saveColumns(db, w.member, w.ops.id, [], 0, 10)).toMatchObject(forbidden);
		expect(await db.select().from(labels).where(eq(labels.id, l)).get()).toEqual(lb);
		expect(await db.select().from(milestones).where(eq(milestones.id, m)).get()).toEqual(mb);
		// The lead, the creator (admin here) and any admin pass the same statement.
		expect((await updateLabel(db, w.lead, w.ops.id, l, input, lb.updatedAt, 20)).ok).toBe(true);
		expect(
			(await setMilestoneStatus(db, w.admin, w.ops.id, m, 'closed', mb.updatedAt, 20)).ok
		).toBe(true);
	});

	it('the route answers 403 when the rule fails inside the write', async () => {
		const w = await world();
		const l = await label(w.ops.id, w.member, 'Bug');
		// The lead is replaced after the route's read: simulate by asking the repo as the former lead.
		await db.run(sql`update projects set lead_id = ${w.admin.id} where id = ${w.ops.id}`);
		const r = await run(
			settings.actions.labelDelete,
			await req(w.lead, '/projects/OPS/settings', { params: { key: 'OPS' }, form: { id: l } })
		);
		expect(status(r)).toBe(403);
		expect((await listLabels(db, w.ops.id)).map((x) => x.id)).toEqual([l]);
	});
});

describe('milestones', () => {
	it('a 1,000-character CJK or emoji description fits the form body bound (red team L3)', async () => {
		const w = await world();
		for (const ch of ['界', '🚀']) {
			const r = await run(
				settings.actions.milestoneSave,
				await req(w.lead, '/projects/OPS/settings', {
					params: { key: 'OPS' },
					form: { name: `Launch ${ch}`, description: ch.repeat(1000), dueOn: '2026-12-01' }
				})
			);
			expect(status(r)).toBe(200);
			expect(pm(r).ok).toBe(true);
		}
		const rows = await db.select().from(milestones);
		expect(rows.map((m) => Array.from(m.description).length)).toEqual([1000, 1000]);
		// One character over the limit is a field error, not a body refusal.
		const over = await run(
			settings.actions.milestoneSave,
			await req(w.lead, '/projects/OPS/settings', {
				params: { key: 'OPS' },
				form: { name: 'Too long', description: '界'.repeat(1001) }
			})
		);
		expect(status(over)).toBe(400);
		expect(pm(over).errors?.description).toBeTruthy();
	});

	it('51st refused; closed, foreign and deleted milestones cannot receive tasks; delete clears links', async () => {
		const w = await world();
		const ids = [];
		for (let i = 0; i < 50; i++) ids.push(await milestone(w.ops.id, w.lead, `M${i}`));
		expect(
			await createMilestone(db, w.lead, w.ops.id, { name: 'M50', description: '', dueOn: null }, 1)
		).toMatchObject({
			ok: false,
			reason: 'limit'
		});
		const t = await seedTask(db, w.admin, w.ops);
		const patch = async (value: string | null) => {
			const row = (await taskRow(db, t.id))!;
			return patchTask(
				db,
				w.member,
				w.ops,
				{ id: t.id, assigneeId: null },
				'milestoneId',
				value,
				row.updatedAt,
				Date.now()
			);
		};
		expect((await patch(ids[0]!)).ok).toBe(true);
		const ms = (await db.select().from(milestones).where(eq(milestones.id, ids[1]!)).get())!;
		expect(
			(await setMilestoneStatus(db, w.admin, w.ops.id, ids[1]!, 'closed', ms.updatedAt, Date.now()))
				.ok
		).toBe(true);
		expect(await patch(ids[1]!)).toMatchObject({
			ok: false,
			reason: 'invalid',
			errors: { milestoneId: expect.any(String) }
		});
		const foreign = await milestone(w.other.id, w.admin);
		expect(await patch(foreign)).toMatchObject({ ok: false, reason: 'invalid' });
		await deleteMilestone(db, w.admin, w.ops.id, ids[2]!, Date.now());
		expect(await patch(ids[2]!)).toMatchObject({ ok: false, reason: 'invalid' });
		expect((await taskRow(db, t.id))?.milestoneId).toBe(ids[0]);
		// A closed milestone already on a task stays when the task is edited.
		const own = (await db.select().from(milestones).where(eq(milestones.id, ids[0]!)).get())!;
		await setMilestoneStatus(db, w.admin, w.ops.id, ids[0]!, 'closed', own.updatedAt, Date.now());
		expect((await patch(ids[0]!)).ok).toBe(true);
		// Deleting clears the link without bumping the task's version.
		const before = (await taskRow(db, t.id))!;
		expect((await deleteMilestone(db, w.admin, w.ops.id, ids[0]!, Date.now())).ok).toBe(true);
		const after = (await taskRow(db, t.id))!;
		expect(after.milestoneId).toBeNull();
		expect(after.updatedAt).toBe(before.updatedAt);
		expect(await deleteMilestone(db, w.admin, w.ops.id, NONE, 1)).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
	});

	it('edit and close compare updated_at; progress is done over the non-canceled total', async () => {
		const w = await world();
		const m = await milestone(w.ops.id, w.lead);
		const row = (await db.select().from(milestones).where(eq(milestones.id, m)).get())!;
		const input = { name: 'Beta 2', description: 'x', dueOn: '2026-12-01' };
		expect(
			(await updateMilestone(db, w.admin, w.ops.id, m, input, row.updatedAt, row.updatedAt + 5)).ok
		).toBe(true);
		expect(
			await updateMilestone(db, w.admin, w.ops.id, m, input, row.updatedAt, row.updatedAt + 6)
		).toMatchObject({
			ok: false,
			reason: 'conflict'
		});
		for (const s of ['done', 'done', 'todo', 'canceled', 'in_progress'] as const)
			await seedTask(db, w.admin, w.ops, { status: s, milestoneId: m });
		await seedTask(db, w.admin, w.ops, { status: 'done' });
		const p = (await milestoneProgress(db, w.ops.id)).get(m)!;
		expect(p).toMatchObject({ done: 2, total: 4, percent: 50 });
		const page = await run(
			milestonePage.load,
			await req(w.member, `/projects/OPS/milestones/${m}`, { params: { key: 'OPS', id: m } })
		);
		expect((page as { progress: { done: number; total: number } }).progress).toMatchObject({
			done: 2,
			total: 4
		});
		expect((page as { tasks: unknown[] }).tasks).toHaveLength(5);
	});
});

// ── Columns and WIP ─────────────────────────────────────────────────────────────────────────────────────────

describe('board columns', () => {
	const form = (fields: Record<string, string>) => {
		const f = new FormData();
		for (const [k, v] of Object.entries(fields)) f.append(k, v);
		const parsed = parseColumns(f);
		if (!parsed.ok) throw new Error('columns');
		return parsed.value;
	};

	it('rename shows on the board only; the status stays; hiding a column with tasks is refused', async () => {
		const w = await world();
		const t = await seedTask(db, w.admin, w.ops, { status: 'in_review' });
		expect(
			(await saveColumns(db, w.admin, w.ops.id, form({ label_in_review: 'QA' }), 0, 100)).ok
		).toBe(true);
		const cols = await getColumns(db, w.ops.id);
		expect(cols.columns.find((c) => c.status === 'in_review')).toMatchObject({
			label: 'QA',
			taskCount: 1
		});
		expect((await taskRow(db, t.id))?.status).toBe('in_review');
		const refused = await saveColumns(
			db,
			w.admin,
			w.ops.id,
			form({ hidden_in_review: 'on' }),
			cols.version,
			200
		);
		expect(refused).toMatchObject({
			ok: false,
			reason: 'invalid',
			errors: { hidden_in_review: '1 task uses this column.' }
		});
		// Nothing of a refused save is written (the rename stays).
		expect(
			(await getColumns(db, w.ops.id)).columns.find((c) => c.status === 'in_review')?.label
		).toBe('QA');
		expect(
			(await saveColumns(db, w.admin, w.ops.id, form({ hidden_canceled: 'on' }), cols.version, 300))
				.ok
		).toBe(true);
		const after = await getColumns(db, w.ops.id);
		expect(after.columns.find((c) => c.status === 'canceled')?.hidden).toBe(true);
		// The rename was reset (an empty row is the default); a stale version conflicts.
		expect(after.columns.find((c) => c.status === 'in_review')?.label).toBe('In review');
		expect(await saveColumns(db, w.admin, w.ops.id, form({}), cols.version, 400)).toMatchObject({
			reason: 'conflict'
		});
		// The board load leaves the hidden column out through the settings it sends.
		const board = await run(
			view.load,
			await req(w.admin, '/projects/OPS?view=board', { params: { key: 'OPS' } })
		);
		expect(
			(board as { columns: { status: string; hidden: boolean }[] }).columns
				.filter((c) => c.hidden)
				.map((c) => c.status)
		).toEqual(['canceled']);
	});

	it('hide vs. a concurrent move into the column: never hidden with tasks unless already hidden', async () => {
		const w = await world();
		const t = await seedTask(db, w.admin, w.ops, { status: 'todo' });
		await Promise.all([
			saveColumns(db, w.admin, w.ops.id, form({ hidden_backlog: 'on' }), 0, 100),
			moveTask(db, w.ops, t.id, 'backlog', { place: 'bottom' }, 101)
		]);
		const cols = await getColumns(db, w.ops.id);
		const backlog = cols.columns.find((c) => c.status === 'backlog')!;
		// Either order is fine; a move is never refused. If the hide won first the task may now sit in it.
		expect((await taskRow(db, t.id))?.status).toBe('backlog');
		expect(backlog.taskCount).toBe(1);
	});

	it('WIP: 4 tasks over a limit of 3, a 5th move is allowed; 0, 201 and 2.5 refused by the route', async () => {
		const w = await world();
		for (let i = 0; i < 4; i++) await seedTask(db, w.admin, w.ops, { status: 'in_progress' });
		const fifth = await seedTask(db, w.admin, w.ops, { status: 'todo' });
		expect(
			(await saveColumns(db, w.admin, w.ops.id, form({ wip_in_progress: '3' }), 0, 100)).ok
		).toBe(true);
		expect((await moveTask(db, w.ops, fifth.id, 'in_progress', { place: 'bottom' }, 200)).ok).toBe(
			true
		);
		const col = (await getColumns(db, w.ops.id)).columns.find((c) => c.status === 'in_progress')!;
		expect(col).toMatchObject({ wipLimit: 3, taskCount: 5 });
		for (const bad of ['0', '201', '2.5']) {
			const r = await run(
				settings.actions.columnsSave,
				await req(w.lead, '/projects/OPS/settings', {
					params: { key: 'OPS' },
					form: { expectedUpdatedAt: '101', wip_in_progress: bad }
				})
			);
			expect(status(r), bad).toBe(400);
			expect(pm(r).errors?.wip_in_progress).toBeTruthy();
		}
		const cleared = await run(
			settings.actions.columnsSave,
			await req(w.lead, '/projects/OPS/settings', {
				params: { key: 'OPS' },
				form: { expectedUpdatedAt: String((await getColumns(db, w.ops.id)).version) }
			})
		);
		expect(pm(cleared).ok).toBe(true);
		expect((await getColumns(db, w.ops.id)).columns.every((c) => c.wipLimit === null)).toBe(true);
	});
});

// ── Filters and saved views ─────────────────────────────────────────────────────────────────────────────────

describe('filters and saved views', () => {
	it('label (OR) and milestone (incl. none) compose with RB-01 filters; invalid ids are dropped', async () => {
		const w = await world();
		const bug = await label(w.ops.id, w.member, 'Bug');
		const ux = await label(w.ops.id, w.member, 'UX');
		const m = await milestone(w.ops.id, w.lead);
		const a = await seedTask(db, w.admin, w.ops, { status: 'todo', milestoneId: m });
		const b = await seedTask(db, w.admin, w.ops, { status: 'done' });
		const c = await seedTask(db, w.admin, w.ops, { status: 'todo' });
		await setTaskLabels(db, w.ops.id, a.id, [bug], 1);
		await setTaskLabels(db, w.ops.id, b.id, [ux], 1);
		const numbers = async (q: string) => {
			const r = (await run(
				view.load,
				await req(w.admin, `/projects/OPS?${q}`, { params: { key: 'OPS' } })
			)) as {
				list: { rows: { number: number }[] };
				filters: { labels: string[]; milestone: unknown };
			};
			return { rows: r.list.rows.map((x) => x.number).sort(), filters: r.filters };
		};
		expect((await numbers(`label=${bug}&label=${ux}`)).rows).toEqual([a.number, b.number]);
		expect((await numbers(`label=${bug}&label=${ux}&status=todo`)).rows).toEqual([a.number]);
		expect((await numbers(`milestone=${m}`)).rows).toEqual([a.number]);
		expect((await numbers('milestone=none')).rows).toEqual([b.number, c.number]);
		const foreign = await label(w.other.id, w.admin, 'Foreign');
		const dropped = await numbers(`label=${foreign}&milestone=${NONE}`);
		expect(dropped.rows).toEqual([a.number, b.number, c.number]);
		expect(dropped.filters).toMatchObject({ labels: [], milestone: 'any' });
		const board = await boardTasks(db, w.ops.id, { ...noFilters, labels: [bug] }, w.admin.id);
		expect(board.flatMap((col) => col.tasks.map((t) => t.id))).toEqual([a.id]);
	});

	it('save from the filters; only whitelisted keys stored; open restores; others get 404', async () => {
		const w = await world();
		const save = async (who: SessionUser, name: string, query: string, kind = 'list') =>
			run(
				view.actions.viewSave,
				await req(who, '/projects/OPS', { params: { key: 'OPS' }, form: { name, kind, query } })
			);
		const r = await save(
			w.member,
			'Mine',
			'status=todo&x=<script>&sort=;drop&priority=high&page=3'
		);
		expect(pm(r).ok).toBe(true);
		const stored = (await db
			.select()
			.from(savedViews)
			.where(eq(savedViews.id, pm(r).id!))
			.get())!;
		expect(stored.query).toBe('status=todo&priority=high');
		const opened = await run(
			openView.GET,
			await req(w.member, `/projects/OPS/views/${stored.id}`, {
				params: { key: 'OPS', id: stored.id }
			})
		);
		expect(status(opened)).toBe(303);
		expect((opened as { location: string }).location).toBe(
			'/projects/OPS?status=todo&priority=high'
		);
		const theirs = await run(
			openView.GET,
			await req(w.lead, `/projects/OPS/views/${stored.id}`, {
				params: { key: 'OPS', id: stored.id }
			})
		);
		const missing = await run(
			openView.GET,
			await req(w.lead, `/projects/OPS/views/${NONE}`, { params: { key: 'OPS', id: NONE } })
		);
		expect(status(theirs)).toBe(404);
		expect((theirs as { body: unknown }).body).toEqual((missing as { body: unknown }).body);
		const del = await run(
			view.actions.viewDelete,
			await req(w.lead, '/projects/OPS', { params: { key: 'OPS' }, form: { id: stored.id } })
		);
		expect(status(del)).toBe(404);
		expect(status(await save(w.member, 'Mine', 'status=done'))).toBe(400);
		// Another user may use the same name; the views list is per user.
		expect(pm(await save(w.lead, 'Mine', '')).ok).toBe(true);
		const listed = (await run(
			view.load,
			await req(w.lead, '/projects/OPS', { params: { key: 'OPS' } })
		)) as {
			views: { name: string }[];
		};
		expect(listed.views.map((v) => v.name)).toEqual(['Mine']);
		const board = await save(w.member, 'Board', 'view=board&status=todo&sort=due', 'board');
		const b = (await db
			.select()
			.from(savedViews)
			.where(eq(savedViews.id, pm(board).id!))
			.get())!;
		expect(b).toMatchObject({ kind: 'board', query: 'view=board&status=todo' });
		expect(
			pm(
				await run(
					view.actions.viewDelete,
					await req(w.member, '/projects/OPS', { params: { key: 'OPS' }, form: { id: b.id } })
				)
			).ok
		).toBe(true);
	});

	it('20 views per user and project; 20 concurrent saves against 19: exactly one succeeds', async () => {
		const w = await world();
		for (let i = 0; i < 19; i++)
			await saveView(db, w.member.id, w.ops.id, { name: `V${i}`, kind: 'list', query: '' }, i);
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				saveView(db, w.member.id, w.ops.id, { name: `Race ${i}`, kind: 'list', query: '' }, 100)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(
			await saveView(db, w.member.id, w.ops.id, { name: 'Late', kind: 'list', query: '' }, 200)
		).toMatchObject({
			ok: false,
			reason: 'limit'
		});
	});
});

// ── Bulk edit ───────────────────────────────────────────────────────────────────────────────────────────────

describe('bulk edit', () => {
	const bulkForm = (ids: string[], changes: Record<string, string>) => [
		...ids.map((id) => ['taskId', id] as [string, string]),
		...Object.entries(changes)
	];

	it('100 tasks in one request: status, priority, assignee, milestone, due date and a label', async () => {
		const w = await world();
		const m = await milestone(w.ops.id, w.lead);
		const l = await label(w.ops.id, w.member, 'Bug');
		const ids: string[] = [];
		for (let i = 0; i < 100; i++) ids.push((await seedTask(db, w.admin, w.ops)).id);
		const r = await run(
			view.actions.bulk,
			await req(w.member, '/projects/OPS', {
				params: { key: 'OPS' },
				form: bulkForm(ids, {
					status: 'done',
					priority: 'high',
					assigneeId: w.lead.id,
					milestoneId: m,
					dueOn: '2026-12-24',
					addLabelId: l
				})
			})
		);
		expect(pm(r)).toMatchObject({
			ok: true,
			message: '100 tasks updated. 1 person was notified about the first 10 tasks.'
		});
		const rows = await db.select().from(tasks).where(eq(tasks.projectId, w.ops.id));
		for (const row of rows)
			expect(row).toMatchObject({
				status: 'done',
				priority: 'high',
				assigneeId: w.lead.id,
				milestoneId: m,
				dueOn: '2026-12-24',
				completedAt: expect.any(Number)
			});
		const extras = await taskExtras(db, w.ops.id, ids);
		expect([...extras.values()].every((e) => e.labels.length === 1)).toBe(true);
		// At most 10 notifications per bulk request (red team L2), for the lowest task numbers.
		const notes = await assignedNotifications(db, w.lead.id);
		expect(notes.map((n) => n.targetId).sort()).toEqual(ids.slice(0, 10).sort());
		// Back to todo clears completed_at.
		expect((await bulkUpdate(db, w.member, w.ops.id, ids, { status: 'todo' }, Date.now())).ok).toBe(
			true
		);
		expect((await db.select().from(tasks)).every((t) => t.completedAt === null)).toBe(true);
	});

	it('101 refused; an id outside the project or deleted: 404 and no task changed; archived refused', async () => {
		const w = await world();
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) ids.push((await seedTask(db, w.admin, w.ops)).id);
		const foreign = await seedTask(db, w.admin, w.other);
		const tooMany = Array.from(
			{ length: 101 },
			(_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
		);
		const r101 = await run(
			view.actions.bulk,
			await req(w.member, '/projects/OPS', {
				params: { key: 'OPS' },
				form: bulkForm(tooMany, { status: 'done' })
			})
		);
		expect(status(r101)).toBe(400);
		const outside = await run(
			view.actions.bulk,
			await req(w.member, '/projects/OPS', {
				params: { key: 'OPS' },
				form: bulkForm([...ids, foreign.id], { status: 'done' })
			})
		);
		expect(status(outside)).toBe(404);
		expect(pm(outside).message).toBe('Some tasks no longer exist, reload.');
		await db.update(tasks).set({ deletedAt: 1 }).where(eq(tasks.id, ids[2]!));
		expect(
			await bulkUpdate(db, w.member, w.ops.id, ids, { priority: 'urgent' }, Date.now())
		).toMatchObject({
			ok: false,
			reason: 'not_found'
		});
		expect(
			(await db.select().from(tasks)).every((t) => t.status === 'todo' && t.priority === 'none')
		).toBe(true);
		await archive(db, w.ops.id);
		const archived = await run(
			view.actions.bulk,
			await req(w.member, '/projects/OPS', {
				params: { key: 'OPS' },
				form: bulkForm(ids.slice(0, 2), { status: 'done' })
			})
		);
		expect(status(archived)).toBe(409);
	});

	it('invalid references are field errors and nothing is written', async () => {
		const w = await world();
		const t = await seedTask(db, w.admin, w.ops);
		const off = await insertUser(db, { status: 'disabled' });
		const foreignM = await milestone(w.other.id, w.admin);
		const foreignL = await label(w.other.id, w.admin, 'F');
		expect(
			await bulkUpdate(db, w.member, w.ops.id, [t.id], { priority: 'low', assigneeId: off.id }, 1)
		).toMatchObject({
			ok: false,
			errors: { assigneeId: expect.any(String) }
		});
		expect(
			await bulkUpdate(
				db,
				w.member,
				w.ops.id,
				[t.id],
				{ priority: 'low', milestoneId: foreignM },
				1
			)
		).toMatchObject({
			ok: false,
			errors: { milestoneId: expect.any(String) }
		});
		expect(
			await bulkUpdate(db, w.member, w.ops.id, [t.id], { addLabelId: foreignL }, 1)
		).toMatchObject({
			ok: false,
			errors: { addLabelId: expect.any(String) }
		});
		expect((await taskRow(db, t.id))?.priority).toBe('none');
	});

	it('notifications only where the assignee changed, never to oneself; the 10-label cap holds', async () => {
		const w = await world();
		const a = await seedTask(db, w.admin, w.ops, { assigneeId: w.lead.id });
		const b = await seedTask(db, w.admin, w.ops);
		await db.run(sql`delete from notifications`);
		expect(
			(
				await bulkUpdate(
					db,
					w.member,
					w.ops.id,
					[a.id, b.id],
					{ assigneeId: w.lead.id },
					Date.now()
				)
			).ok
		).toBe(true);
		expect((await assignedNotifications(db, w.lead.id)).map((n) => n.targetId)).toEqual([b.id]);
		expect(
			(
				await bulkUpdate(
					db,
					w.member,
					w.ops.id,
					[a.id, b.id],
					{ assigneeId: w.member.id },
					Date.now()
				)
			).ok
		).toBe(true);
		expect(await assignedNotifications(db, w.member.id)).toHaveLength(0);
		const ids = [];
		for (let i = 0; i < 11; i++) ids.push(await label(w.ops.id, w.member, `L${i}`));
		await setTaskLabels(db, w.ops.id, a.id, ids.slice(0, 10), 1);
		const r = await bulkUpdate(
			db,
			w.member,
			w.ops.id,
			[a.id, b.id],
			{ addLabelId: ids[10]! },
			Date.now()
		);
		expect(r).toMatchObject({ ok: true, labelCapped: 1 });
		const extras = await taskExtras(db, w.ops.id, [a.id, b.id]);
		expect(extras.get(a.id)?.labels).toHaveLength(10);
		expect(extras.get(b.id)?.labels.map((l) => l.id)).toEqual([ids[10]]);
		expect(
			(
				await bulkUpdate(
					db,
					w.member,
					w.ops.id,
					[a.id, b.id],
					{ removeLabelId: ids[10]! },
					Date.now()
				)
			).ok
		).toBe(true);
		expect((await taskExtras(db, w.ops.id, [b.id])).get(b.id)?.labels).toEqual([]);
	});

	it('a bulk status change appends the tasks to the bottom of the column in ascending number order', async () => {
		const w = await world();
		const existing = await seedTask(db, w.admin, w.ops, { status: 'done' });
		const moved = [];
		for (let i = 0; i < 4; i++) moved.push(await seedTask(db, w.admin, w.ops, { status: 'todo' }));
		const ids = [moved[3]!.id, moved[0]!.id, moved[2]!.id, moved[1]!.id];
		expect((await bulkUpdate(db, w.member, w.ops.id, ids, { status: 'done' }, Date.now())).ok).toBe(
			true
		);
		const board = await boardTasks(db, w.ops.id, noFilters, w.admin.id);
		const done = board.find((c) => c.status === 'done')!.tasks.map((t) => t.number);
		expect(done).toEqual([existing.number, ...moved.map((m) => m.number)]);
	});

	it('the 100-parameter rule: a 300-task board and a 100-task bulk bind one JSON list', async () => {
		const w = await world();
		const ids: string[] = [];
		for (let i = 0; i < 300; i++)
			ids.push((await seedTask(db, w.admin, w.ops, { status: i % 2 ? 'todo' : 'backlog' })).id);
		const l = await label(w.ops.id, w.member, 'Bulk');
		expect(
			(
				await bulkUpdate(
					db,
					w.member,
					w.ops.id,
					ids.slice(0, 100),
					{ addLabelId: l, priority: 'low' },
					Date.now()
				)
			).ok
		).toBe(true);
		const loaded = (await run(
			view.load,
			await req(w.admin, '/projects/OPS?view=board', { params: { key: 'OPS' } })
		)) as {
			board: { tasks: { labels: unknown[] }[] }[];
		};
		const cards = loaded.board.flatMap((c) => c.tasks);
		expect(cards).toHaveLength(200);
		expect(cards.filter((c) => c.labels.length === 1).length).toBeGreaterThan(0);
	});
});

// ── Cross-cutting ───────────────────────────────────────────────────────────────────────────────────────────

describe('cross-cutting', () => {
	it('list and board loads make the same number of D1 statements for 5 and 120 tasks', async () => {
		const w = await world();
		const small = w.ops;
		const big = w.other;
		const l1 = await label(small.id, w.admin, 'A');
		const l2 = await label(big.id, w.admin, 'A');
		for (let i = 0; i < 5; i++) {
			const t = await seedTask(db, w.admin, small);
			await setTaskLabels(db, small.id, t.id, [l1], 1);
			await addItem(db, w.admin, small.id, t.id, 'x', 1);
		}
		for (let i = 0; i < 120; i++) {
			const t = await seedTask(db, w.admin, big, { status: i % 3 ? 'todo' : 'done' });
			await setTaskLabels(db, big.id, t.id, [l2], 1);
			await addItem(db, w.admin, big.id, t.id, 'x', 1);
		}
		const counted = async (key: string, q: string) => {
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
				view.load,
				await req(w.admin, `/projects/${key}${q}`, { params: { key }, database: getDb(proxy) })
			);
			expect(status(r)).toBe(200);
			return n;
		};
		expect(await counted('OPS', '')).toBe(await counted('OTHER', ''));
		expect(await counted('OPS', '?view=board')).toBe(await counted('OTHER', '?view=board'));
	});

	it('archived project: every new mutation is refused server-side; reads still work', async () => {
		const w = await world();
		const t = await seedTask(db, w.admin, w.ops);
		const l = await label(w.ops.id, w.admin, 'Bug');
		const m = await milestone(w.ops.id, w.admin);
		const item = await addItem(db, w.admin, w.ops.id, t.id, 'x', 1);
		if (!item.ok) throw new Error('add');
		const view1 = await saveView(
			db,
			w.admin.id,
			w.ops.id,
			{ name: 'V', kind: 'list', query: '' },
			1
		);
		if (!view1.ok) throw new Error('view');
		await archive(db, w.ops.id);
		const results = [
			await createLabel(db, w.admin, w.ops.id, { name: 'New', nameKey: 'new', color: 'red' }, 2),
			await deleteLabel(db, w.admin, w.ops.id, l, 2),
			await setTaskLabels(db, w.ops.id, t.id, [l], 2),
			await addItem(db, w.admin, w.ops.id, t.id, 'y', 2),
			await toggleItem(db, w.admin, w.ops.id, t.id, item.id, true, 2),
			await editItem(db, w.ops.id, t.id, item.id, 'z', 1, 2),
			await deleteItem(db, w.ops.id, t.id, item.id, 2),
			await moveItem(db, w.ops.id, t.id, item.id, 'down', 2),
			await createMilestone(db, w.admin, w.ops.id, { name: 'N', description: '', dueOn: null }, 2),
			await deleteMilestone(db, w.admin, w.ops.id, m, 2),
			await saveColumns(db, w.admin, w.ops.id, [], 0, 2),
			await saveView(db, w.admin.id, w.ops.id, { name: 'W', kind: 'list', query: '' }, 2),
			await bulkUpdate(db, w.admin, w.ops.id, [t.id], { priority: 'low' }, 2)
		];
		for (const r of results) expect(r).toMatchObject({ ok: false, reason: 'archived' });
		const add = await run(
			detail.actions.checkAdd,
			await req(w.admin, '/projects/OPS/tasks/1', {
				params: { key: 'OPS', number: '1' },
				form: { text: 'x' }
			})
		);
		expect(status(add)).toBe(409);
		const page = await run(
			detail.load,
			await req(w.admin, '/projects/OPS/tasks/1', { params: { key: 'OPS', number: '1' } })
		);
		expect((page as { checklist: unknown[] }).checklist).toHaveLength(1);
		expect(
			status(
				await run(
					settings.load,
					await req(w.admin, '/projects/OPS/settings', { params: { key: 'OPS' } })
				)
			)
		).toBe(200);
	});

	it('task search is unchanged: labels, steps and milestones are not indexed; tombstones stay hidden', async () => {
		const w = await world();
		const t = await seedTask(db, w.admin, w.ops, { title: 'Quarterly harbour audit' });
		const gone = await seedTask(db, w.admin, w.ops, { title: 'Harbour fence repair' });
		const before = (await searchAll(db, 'harbour', { type: 'tasks' })).tasks
			.map((x) => x.id)
			.sort();
		await label(w.ops.id, w.admin, 'Zanzibar');
		await addItem(db, w.admin, w.ops.id, t.id, 'Check the Zanzibar manifest', 1);
		await milestone(w.ops.id, w.admin, 'Zanzibar release');
		await bulkUpdate(db, w.admin, w.ops.id, [t.id, gone.id], { priority: 'high' }, Date.now());
		expect((await searchAll(db, 'zanzibar', { type: 'tasks' })).tasks).toEqual([]);
		expect(
			(await searchAll(db, 'harbour', { type: 'tasks' })).tasks.map((x) => x.id).sort()
		).toEqual(before);
		await db.update(tasks).set({ deletedAt: 1 }).where(eq(tasks.id, gone.id));
		expect((await searchAll(db, 'harbour', { type: 'tasks' })).tasks.map((x) => x.id)).toEqual([
			t.id
		]);
	});

	it('My tasks shows label chips and the milestone', async () => {
		const w = await world();
		const m = await milestone(w.ops.id, w.admin, 'Launch');
		const l = await label(w.ops.id, w.admin, 'Bug');
		const t = await seedTask(db, w.admin, w.ops, { assigneeId: w.member.id, milestoneId: m });
		await setTaskLabels(db, w.ops.id, t.id, [l], 1);
		const r = (await run(myTasks.load, await req(w.member, '/my-tasks'))) as {
			groups: { none: { milestoneName: string | null; labels: { name: string }[] }[] };
		};
		expect(r.groups.none[0]).toMatchObject({ milestoneName: 'Launch', labels: [{ name: 'Bug' }] });
	});

	it('user text is stored as cleaned plain text and rendered escaped (no markup interpreted)', async () => {
		const w = await world();
		const ok = await run(
			settings.actions.labelSave,
			await req(w.admin, '/projects/OPS/settings', {
				params: { key: 'OPS' },
				form: { name: '<img src=x onerror=alert(1)>\u202e', color: 'red' }
			})
		);
		expect(pm(ok).ok).toBe(true);
		const stored = (await listLabels(db, w.ops.id))[0]!;
		expect(stored.name).toBe('<img src=x onerror=alert(1)>');
		const { body } = render(LabelChip, { props: { name: stored.name, color: stored.color } });
		expect(body).not.toContain('<img');
		expect(body).toContain('&lt;img src=x onerror=alert(1)>');
	});
});

describe('migration 0010', () => {
	it('applies on a database with existing tasks without data loss; milestone_id is NULL; FTS triggers kept', async () => {
		const old = await openLocalD1({ before: '0010' });
		try {
			const odb = getDb(old.db);
			const u = await insertUser(odb);
			await old.db
				.prepare(
					`INSERT INTO projects (id, key, name, status, created_by, created_at, updated_at) VALUES ('p1', 'OLD', 'Old', 'active', ?1, 1, 1)`
				)
				.bind(u.id)
				.run();
			await old.db
				.prepare(
					`INSERT INTO tasks (id, project_id, number, title, description, status, created_by, created_at, updated_at) VALUES ('t1', 'p1', 1, 'Legacy lighthouse task', 'Body', 'todo', ?1, 1, 1)`
				)
				.bind(u.id)
				.run();
			await applyMigration(old.db, '0010_pm_plus.sql');
			const row = await old.db
				.prepare(`SELECT title, description, status, milestone_id AS m FROM tasks WHERE id = 't1'`)
				.first<{ title: string; description: string; status: string; m: string | null }>();
			expect(row).toEqual({
				title: 'Legacy lighthouse task',
				description: 'Body',
				status: 'todo',
				m: null
			});
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
			expect((await searchAll(odb, 'lighthouse', { type: 'tasks' })).tasks).toHaveLength(1);
			await old.db.prepare(`UPDATE tasks SET title = 'Renamed beacon task' WHERE id = 't1'`).run();
			expect((await searchAll(odb, 'beacon', { type: 'tasks' })).tasks).toHaveLength(1);
		} finally {
			await old.dispose();
		}
	});
});
