import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import {
	createPage,
	deletePage,
	getBreadcrumbs,
	getChildren,
	getPage,
	getRevision,
	listRevisions,
	listScopePages,
	movePage,
	MOVE_UNDER_SELF,
	PARENT_GONE,
	PARENT_OTHER_SCOPE,
	PROJECT_GONE,
	restoreRevision,
	savePage,
	TOO_DEEP
} from '#lib/server/kb/repo';
import { buildTree } from '#lib/server/kb/tree';
import { openLocalD1 } from '../helpers/d1';
import { insertProject, pageRow, revisionsOf } from '../helpers/seed-kb';
import { insertUser } from '../helpers/users';

/** RB-02 repo invariants against real local D1: revisions, concurrency, tree rules, subtree move and delete. */

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
	admin = await insertUser(db, { role: 'admin', name: 'Ada Admin' });
	member = await insertUser(db, { role: 'member', name: 'Max Member' });
	other = await insertUser(db, { role: 'member', name: 'Olu Other' });
});

let clock = 1_800_000_000_000;
const tick = () => (clock += 1000);

async function page(
	title: string,
	opts: {
		parentId?: string | null;
		projectId?: string | null;
		body?: string;
		by?: SessionUser;
	} = {}
): Promise<string> {
	const result = await createPage(
		db,
		opts.by ?? member,
		{
			title,
			body: opts.body ?? '',
			parentId: opts.parentId ?? null,
			projectId: opts.projectId ?? null
		},
		tick()
	);
	if (!result.ok) throw new Error(`create failed: ${result.error}`);
	return result.id;
}

/** A chain of `n` pages, each under the previous; returns their ids top first. */
async function chain(n: number, projectId: string | null = null): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < n; i++)
		ids.push(await page(`Level ${i + 1}`, { parentId: ids[i - 1] ?? null, projectId }));
	return ids;
}

const count = async (table: string) =>
	Number(
		(await db.$client.prepare(`select count(*) as n from ${table}`).first<{ n: number }>())?.n
	);

describe('create', () => {
	it('writes a team page and a project page with revision 1, each in its own tree', async () => {
		const project = await insertProject(db, admin.id);
		const team = await page('Team handbook', { body: '# Hello' });
		const proj = await page('Project plan', { projectId: project.id });
		expect(await revisionsOf(db, team)).toEqual([
			{ revision: 1, title: 'Team handbook', body: '# Hello', editedBy: member.id }
		]);
		expect((await pageRow(db, proj))?.projectId).toBe(project.id);
		expect((await listScopePages(db, null)).rows.map((r) => r.id)).toEqual([team]);
		expect((await listScopePages(db, project.id)).rows.map((r) => r.id)).toEqual([proj]);
		const detail = await getPage(db, proj);
		expect(detail).toMatchObject({
			revision: 1,
			createdByName: 'Max Member',
			editedByName: 'Max Member',
			project: { key: project.key, status: 'active' }
		});
	});

	it('refuses a parent in another scope, a deleted or missing parent, and a deleted project; writes nothing', async () => {
		const project = await insertProject(db, admin.id);
		const gone = await insertProject(db, admin.id, { deletedAt: clock });
		const teamParent = await page('Team parent');
		const before = { pages: await count('pages'), revs: await count('page_revisions') };
		const tries = [
			{ parentId: teamParent, projectId: project.id, field: 'parent', error: PARENT_OTHER_SCOPE },
			{
				parentId: crypto.randomUUID(),
				projectId: null,
				field: 'parent',
				error: PARENT_GONE
			},
			{ parentId: null, projectId: gone.id, field: 'project', error: PROJECT_GONE },
			{ parentId: null, projectId: crypto.randomUUID(), field: 'project', error: PROJECT_GONE }
		];
		for (const t of tries) {
			const result = await createPage(
				db,
				member,
				{ title: 'x', body: '', parentId: t.parentId, projectId: t.projectId },
				tick()
			);
			expect(result).toEqual({ ok: false, field: t.field, error: t.error });
		}
		await deletePage(db, member, teamParent, tick());
		const underDeleted = await createPage(
			db,
			member,
			{ title: 'x', body: '', parentId: teamParent, projectId: null },
			tick()
		);
		expect(underDeleted).toMatchObject({ ok: false, field: 'parent' });
		expect(await count('pages')).toBe(before.pages);
		expect(await count('page_revisions')).toBe(before.revs);
	});

	it('refuses depth 9', async () => {
		const ids = await chain(8);
		const result = await createPage(
			db,
			member,
			{ title: 'Too deep', body: '', parentId: ids[7] as string, projectId: null },
			tick()
		);
		expect(result).toEqual({ ok: false, field: 'parent', error: TOO_DEEP });
	});

	it('appends after the last sibling', async () => {
		const a = await page('A');
		const b = await page('B');
		expect((await pageRow(db, b))!.position).toBeGreaterThan((await pageRow(db, a))!.position);
	});
});

describe('save and revisions', () => {
	it('a save adds exactly one matching revision; an unchanged save adds none', async () => {
		const id = await page('Draft', { body: 'one' });
		const saved = await savePage(db, other, id, { title: 'Final', body: 'two' }, 1, tick());
		expect(saved).toEqual({ kind: 'saved', revision: 2 });
		expect(await revisionsOf(db, id)).toEqual([
			{ revision: 1, title: 'Draft', body: 'one', editedBy: member.id },
			{ revision: 2, title: 'Final', body: 'two', editedBy: other.id }
		]);
		const same = await savePage(db, other, id, { title: 'Final', body: 'two' }, 2, tick());
		expect(same).toEqual({ kind: 'unchanged', revision: 2 });
		expect(await revisionsOf(db, id)).toHaveLength(2);
		expect((await getPage(db, id))?.editedByName).toBe('Olu Other');
	});

	it('a stale save is a conflict carrying the current version; "save mine over theirs" makes N+1', async () => {
		const id = await page('Doc', { body: 'base' });
		await savePage(db, other, id, { title: 'Doc', body: 'theirs' }, 1, tick());
		const mine = await savePage(db, member, id, { title: 'Doc', body: 'mine' }, 1, tick());
		expect(mine).toEqual({
			kind: 'conflict',
			current: { revision: 2, title: 'Doc', body: 'theirs', editedByName: 'Olu Other' }
		});
		const over = await savePage(db, member, id, { title: 'Doc', body: 'mine' }, 2, tick());
		expect(over).toEqual({ kind: 'saved', revision: 3 });
		expect((await revisionsOf(db, id)).map((r) => r.body)).toEqual(['base', 'theirs', 'mine']);
	});

	it('20 concurrent saves from one revision: exactly one wins, revisions stay contiguous', async () => {
		const id = await page('Race', { body: 'start' });
		const users = [admin, member, other];
		const at = tick();
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				savePage(db, users[i % 3] as SessionUser, id, { title: 'Race', body: `v${i}` }, 1, at + i)
			)
		);
		expect(results.filter((r) => r.kind === 'saved')).toHaveLength(1);
		expect(results.filter((r) => r.kind === 'conflict')).toHaveLength(19);
		const revs = await revisionsOf(db, id);
		expect(revs.map((r) => r.revision)).toEqual([1, 2]);
		expect((await pageRow(db, id))?.body).toBe(revs[1]?.body);
	});

	it('20 concurrent saves by one user in the same millisecond also leave contiguous revisions', async () => {
		const id = await page('Same ms', { body: 'start' });
		const at = tick();
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				savePage(db, member, id, { title: 'Same ms', body: `v${i}` }, 1, at)
			)
		);
		expect(results.filter((r) => r.kind === 'saved')).toHaveLength(1);
		const revs = await revisionsOf(db, id);
		expect(revs.map((r) => r.revision)).toEqual([1, 2]);
		expect((await pageRow(db, id))?.body).toBe(revs[1]?.body);
	});

	it('saving a deleted page is not-found', async () => {
		const id = await page('Gone');
		await deletePage(db, member, id, tick());
		expect(await savePage(db, member, id, { title: 'x', body: 'y' }, 1, tick())).toEqual({
			kind: 'not-found'
		});
	});

	it('restore makes a new revision with the old content and refuses a stale form', async () => {
		const id = await page('V1', { body: 'first' });
		await savePage(db, member, id, { title: 'V2', body: 'second' }, 1, tick());
		const restored = await restoreRevision(db, other, id, 1, 2, tick());
		expect(restored).toEqual({ kind: 'saved', revision: 3 });
		expect(await revisionsOf(db, id)).toEqual([
			{ revision: 1, title: 'V1', body: 'first', editedBy: member.id },
			{ revision: 2, title: 'V2', body: 'second', editedBy: member.id },
			{ revision: 3, title: 'V1', body: 'first', editedBy: other.id }
		]);
		const stale = await restoreRevision(db, other, id, 2, 2, tick());
		expect(stale.kind).toBe('conflict');
		expect(await restoreRevision(db, other, id, 99, 3, tick())).toEqual({ kind: 'not-found' });
	});

	it('history pages at 50, newest first; another page’s revision is not found', async () => {
		const id = await page('Many', { body: '0' });
		for (let i = 1; i <= 54; i++)
			await savePage(db, member, id, { title: 'Many', body: String(i) }, i, tick());
		const first = await listRevisions(db, id, 1);
		expect(first).toHaveLength(50);
		expect(first[0]?.revision).toBe(55);
		expect(first[0]?.editedByName).toBe('Max Member');
		const second = await listRevisions(db, id, 2);
		expect(second.map((r) => r.revision)).toEqual([5, 4, 3, 2, 1]);
		const elsewhere = await page('Elsewhere');
		expect(await getRevision(db, elsewhere, 2)).toBeNull();
		expect((await getRevision(db, id, 2))?.body).toBe('1');
	});
});

describe('move', () => {
	it('refuses itself and any descendant, even through a direct call; nothing changes', async () => {
		const [a, b, c] = (await chain(3)) as [string, string, string];
		const before = await pageRow(db, a);
		for (const target of [a, b, c]) {
			const result = await movePage(
				db,
				member,
				a,
				{ parentId: target, projectId: null, placement: { kind: 'last' } },
				tick()
			);
			expect(result).toEqual({ kind: 'invalid', field: 'parent', error: MOVE_UNDER_SELF });
		}
		expect(await pageRow(db, a)).toEqual(before);
	});

	it('moving a subtree into another scope moves every descendant in one batch; breadcrumbs follow', async () => {
		const project = await insertProject(db, admin.id, { name: 'Apollo' });
		const [a, b, c] = (await chain(3)) as [string, string, string];
		const host = await page('Project root', { projectId: project.id });
		const result = await movePage(
			db,
			member,
			a,
			{ parentId: host, projectId: project.id, placement: { kind: 'last' } },
			tick()
		);
		expect(result).toEqual({ kind: 'moved' });
		for (const id of [a, b, c]) expect((await pageRow(db, id))?.projectId).toBe(project.id);
		expect((await getBreadcrumbs(db, c)).map((x) => x.title)).toEqual([
			'Project root',
			'Level 1',
			'Level 2'
		]);
		expect((await listScopePages(db, null)).rows).toHaveLength(0);
		expect(buildTree((await listScopePages(db, project.id)).rows)[0]?.id).toBe(host);
	});

	it('refuses a parent in another scope than the target, and a deleted target project', async () => {
		const project = await insertProject(db, admin.id);
		const gone = await insertProject(db, admin.id, { deletedAt: clock });
		const a = await page('A');
		const p = await page('In project', { projectId: project.id });
		expect(
			await movePage(
				db,
				member,
				a,
				{ parentId: p, projectId: null, placement: { kind: 'last' } },
				tick()
			)
		).toEqual({ kind: 'invalid', field: 'parent', error: PARENT_OTHER_SCOPE });
		expect(
			await movePage(
				db,
				member,
				a,
				{ parentId: null, projectId: gone.id, placement: { kind: 'last' } },
				tick()
			)
		).toEqual({ kind: 'invalid', field: 'project', error: PROJECT_GONE });
	});

	it('counts the subtree height against the depth limit', async () => {
		const deep = await chain(6);
		const sub = await chain(3);
		const tooDeep = await movePage(
			db,
			member,
			sub[0] as string,
			{ parentId: deep[5] as string, projectId: null, placement: { kind: 'last' } },
			tick()
		);
		expect(tooDeep).toEqual({ kind: 'invalid', field: 'parent', error: TOO_DEEP });
		const fits = await movePage(
			db,
			member,
			sub[0] as string,
			{ parentId: deep[4] as string, projectId: null, placement: { kind: 'last' } },
			tick()
		);
		expect(fits).toEqual({ kind: 'moved' });
	});

	it('concurrent valid moves cannot stack past the depth limit (the UPDATE checks depth)', async () => {
		for (let round = 0; round < 5; round++) {
			const t = await chain(4);
			const r = await chain(4);
			const s2 = await chain(4);
			const results = await Promise.all([
				movePage(
					db,
					member,
					s2[0] as string,
					{ parentId: r[3] as string, projectId: null, placement: { kind: 'last' } },
					tick()
				),
				movePage(
					db,
					other,
					r[0] as string,
					{ parentId: t[3] as string, projectId: null, placement: { kind: 'last' } },
					tick()
				)
			]);
			expect(results.filter((x) => x.kind === 'moved')).toHaveLength(1);
			expect(results.find((x) => x.kind === 'invalid')).toEqual({
				kind: 'invalid',
				field: 'parent',
				error: TOO_DEEP
			});
			const deepest = (await getBreadcrumbs(db, s2[3] as string)).length + 1;
			expect(deepest).toBeLessThanOrEqual(8);
		}
	});

	it('changes position and parent without a revision, and an open editor still saves', async () => {
		const a = await page('A');
		const b = await page('B');
		const c = await page('C');
		const moved = await movePage(
			db,
			other,
			c,
			{ parentId: null, projectId: null, placement: { kind: 'first' } },
			tick()
		);
		expect(moved).toEqual({ kind: 'moved' });
		expect(buildTree((await listScopePages(db, null)).rows).map((n) => n.title)).toEqual([
			'C',
			'A',
			'B'
		]);
		await movePage(
			db,
			other,
			c,
			{ parentId: null, projectId: null, placement: { kind: 'after', siblingId: a } },
			tick()
		);
		expect(buildTree((await listScopePages(db, null)).rows).map((n) => n.title)).toEqual([
			'A',
			'C',
			'B'
		]);
		await movePage(
			db,
			other,
			c,
			{ parentId: b, projectId: null, placement: { kind: 'last' } },
			tick()
		);
		expect((await pageRow(db, c))?.revision).toBe(1);
		expect(await revisionsOf(db, c)).toHaveLength(1);
		// The editor opened at revision 1 before the moves still saves.
		expect(await savePage(db, member, c, { title: 'C2', body: '' }, 1, tick())).toEqual({
			kind: 'saved',
			revision: 2
		});
		expect(
			await movePage(
				db,
				other,
				a,
				{ parentId: null, projectId: null, placement: { kind: 'after', siblingId: c } },
				tick()
			)
		).toMatchObject({ kind: 'invalid', field: 'placement' });
	});

	it('renumbers siblings when the midpoint gap is too small', async () => {
		const a = await page('A');
		const b = await page('B');
		const c = await page('C');
		await db.$client
			.prepare(
				`update pages set position = case id when ?1 then 1 when ?2 then 1.0000000001 else 5 end`
			)
			.bind(a, b)
			.run();
		const moved = await movePage(
			db,
			member,
			c,
			{ parentId: null, projectId: null, placement: { kind: 'after', siblingId: a } },
			tick()
		);
		expect(moved).toEqual({ kind: 'moved' });
		expect(buildTree((await listScopePages(db, null)).rows).map((n) => n.title)).toEqual([
			'A',
			'C',
			'B'
		]);
	});
});

describe('delete and tree reads', () => {
	it('tombstones the whole subtree in one statement, idempotently; reads stop seeing it', async () => {
		const [a, b, c] = (await chain(3)) as [string, string, string];
		const keep = await page('Keep');
		const result = await deletePage(db, member, a, tick());
		expect(result).toEqual({ kind: 'deleted', count: 3, projectKey: null });
		for (const id of [a, b, c]) {
			expect((await pageRow(db, id))?.deletedAt).not.toBeNull();
			expect(await getPage(db, id)).toBeNull();
		}
		expect((await listScopePages(db, null)).rows.map((r) => r.id)).toEqual([keep]);
		expect(await getChildren(db, a)).toEqual([]);
		expect(await getBreadcrumbs(db, c)).toEqual([]);
		expect(await deletePage(db, member, a, tick())).toEqual({ kind: 'not-found' });
	});

	it('only the creator or an admin may delete', async () => {
		const id = await page('Mine', { by: member });
		expect(await deletePage(db, other, id, tick())).toEqual({
			kind: 'forbidden',
			reason: 'not-creator'
		});
		expect(await getPage(db, id)).not.toBeNull();
		expect((await deletePage(db, admin, id, tick())).kind).toBe('deleted');
	});

	it('a member cannot delete a subtree holding someone else’s page, even one moved in; an admin can', async () => {
		const theirs = await page('Their runbook', { by: other });
		const mine = await page('Scratch', { by: member });
		const moved = await movePage(
			db,
			member,
			theirs,
			{ parentId: mine, projectId: null, placement: { kind: 'last' } },
			tick()
		);
		expect(moved).toEqual({ kind: 'moved' });
		expect(await deletePage(db, member, mine, tick())).toEqual({
			kind: 'forbidden',
			reason: 'others-in-subtree'
		});
		expect((await pageRow(db, mine))?.deletedAt).toBeNull();
		expect((await pageRow(db, theirs))?.deletedAt).toBeNull();
		expect(await deletePage(db, admin, mine, tick())).toMatchObject({ kind: 'deleted', count: 2 });
	});

	it('a move racing a delete never lets the delete take someone else’s page', async () => {
		for (let round = 0; round < 10; round++) {
			const theirs = await page(`Theirs ${round}`, { by: other });
			const mine = await page(`Mine ${round}`, { by: member });
			const [, deleted] = await Promise.all([
				movePage(
					db,
					member,
					theirs,
					{ parentId: mine, projectId: null, placement: { kind: 'last' } },
					tick()
				),
				deletePage(db, member, mine, tick())
			]);
			expect((await pageRow(db, theirs))?.deletedAt, `round ${round}`).toBeNull();
			if (deleted.kind === 'deleted') expect(deleted.count).toBe(1);
		}
	});

	it('the delete records who deleted (updated_by, updated_at)', async () => {
		const id = await page('Logged', { by: member });
		const at = tick();
		await deletePage(db, admin, id, at);
		const row = await db.$client
			.prepare(
				'select updated_by AS by, updated_at AS at, deleted_at AS gone from pages where id = ?1'
			)
			.bind(id)
			.first<{ by: string; at: number; gone: number }>();
		expect(row).toEqual({ by: admin.id, at, gone: at });
	});

	it('pages of a deleted project are not live', async () => {
		const project = await insertProject(db, admin.id);
		const id = await page('Orphaned', { projectId: project.id });
		await db.$client
			.prepare(`update projects set deleted_at = 1 where id = ?1`)
			.bind(project.id)
			.run();
		expect(await getPage(db, id)).toBeNull();
	});

	it('breadcrumbs list every ancestor top first; children are ordered', async () => {
		const ids = await chain(8);
		expect((await getBreadcrumbs(db, ids[7] as string)).map((x) => x.id)).toEqual(ids.slice(0, 7));
		const parent = ids[0] as string;
		const extra = await page('Another child', { parentId: parent });
		expect((await getChildren(db, parent)).map((c) => c.id)).toEqual([ids[1], extra]);
	});

	it('a scope over 2000 pages loads three levels and marks the cut branches', async () => {
		const [a, b, c] = (await chain(5)) as [string, string, string, string, string];
		// 1997 more top-level pages (2002 in all; the top three levels hold 2000), written in one statement (the FTS triggers fire for each).
		await db.$client
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1997)
				 INSERT INTO pages (id, title, body, position, revision, created_by, updated_by, created_at, updated_at)
				 SELECT lower(hex(randomblob(16))), 'Bulk ' || i, '', i + 10000, 1, ?1, ?1, 1, 1 FROM n`
			)
			.bind(member.id)
			.run();
		const { rows, truncated } = await listScopePages(db, null);
		expect(truncated).toBe(true);
		expect(rows).toHaveLength(2000);
		const third = rows.find((r) => r.id === c);
		expect(third?.more).toBe(true);
		expect(rows.find((r) => r.id === a)?.more).toBe(false);
		expect(rows.some((r) => r.id === b)).toBe(true);
	});
});
