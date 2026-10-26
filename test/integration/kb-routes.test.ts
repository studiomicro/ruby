import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveSession, type SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { createPage, deletePage, savePage } from '#lib/server/kb/repo';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { insertProject, pageRow, revisionsOf } from '../helpers/seed-kb';
import { insertSession, insertUser } from '../helpers/users';

/** The RB-02 routes' loads and actions called directly: access, 404s, no-JS flows, conflict and delete rules. */

const kbIndex = await import('../../src/routes/(app)/kb/+page.server');
const kbProject = await import('../../src/routes/(app)/kb/projects/[key]/+page.server');
const kbNew = await import('../../src/routes/(app)/kb/new/+page.server');
const kbView = await import('../../src/routes/(app)/kb/[id]/+page.server');
const kbEdit = await import('../../src/routes/(app)/kb/[id]/edit/+page.server');
const kbMove = await import('../../src/routes/(app)/kb/[id]/move/+page.server');
const kbDelete = await import('../../src/routes/(app)/kb/[id]/delete/+page.server');
const kbHistory = await import('../../src/routes/(app)/kb/[id]/history/+page.server');
const kbRevision = await import('../../src/routes/(app)/kb/[id]/history/[revision]/+page.server');

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
		user?: SessionUser | null;
		params?: Record<string, string>;
		form?: Record<string, string>;
	} = {}
) =>
	fakeEvent({
		url: `http://localhost${path}`,
		db,
		user: init.user === undefined ? member : (init.user ?? undefined),
		params: init.params,
		form: init.form
	}).event;

async function newPage(title = 'Page', by: SessionUser = member, parentId: string | null = null) {
	const r = await createPage(
		db,
		by,
		{ title, body: 'Body', parentId, projectId: null },
		Date.now()
	);
	if (!r.ok) throw new Error(r.error);
	return r.id;
}

describe('access', () => {
	it('signed out: every load and action is refused with 401', async () => {
		const id = await newPage();
		const params = { id, revision: '1', key: 'OPS' };
		const fns: unknown[] = [
			kbIndex.load,
			kbProject.load,
			kbNew.load,
			kbNew.actions.create,
			kbNew.actions.preview,
			kbView.load,
			kbEdit.load,
			kbEdit.actions.save,
			kbEdit.actions.preview,
			kbMove.load,
			kbMove.actions.move,
			kbDelete.load,
			kbDelete.actions.delete,
			kbHistory.load,
			kbHistory.actions.restore,
			kbRevision.load,
			kbRevision.actions.restore
		];
		for (const [i, fn] of fns.entries()) {
			const e = await call(fn, ev(`/kb/${id}`, { user: null, params, form: { title: 'x' } }));
			expect(status(e), `fn ${i}`).toBe(401);
		}
	});

	it('a deactivated user’s session no longer resolves (so they are signed out)', async () => {
		const gone = await insertUser(db, { status: 'disabled' });
		const token = await insertSession(db, gone.id);
		expect(await resolveSession(db, token, Date.now())).toBeNull();
	});

	it('malformed, missing and deleted ids all give the same 404, on loads and actions', async () => {
		const deleted = await newPage('Deleted');
		await deletePage(db, member, deleted, Date.now());
		for (const id of ['not-a-uuid', crypto.randomUUID(), deleted, '../admin']) {
			for (const fn of [kbView.load, kbEdit.load, kbMove.load, kbDelete.load, kbHistory.load]) {
				const e = await call(fn, ev(`/kb/x`, { params: { id } }));
				expect(status(e)).toBe(404);
				expect(isHttpError(e) && e.body.message).toBe('Page not found.');
			}
			const save = await call(
				kbEdit.actions.save,
				ev('/kb/x/edit', { params: { id }, form: { title: 't', body: '', expectedRevision: '1' } })
			);
			expect(status(save)).toBe(404);
		}
	});

	it('revision numbers 0, abc, 999999 and another page’s revision are 404', async () => {
		const id = await newPage();
		const otherPage = await newPage('Other');
		await savePage(db, member, otherPage, { title: 'Other', body: 'v2' }, 1, Date.now());
		for (const revision of ['0', 'abc', '999999', '2', '-1', '1e1'])
			expect(status(await call(kbRevision.load, ev('/kb/x', { params: { id, revision } })))).toBe(
				404
			);
		const ok = (await call(kbRevision.load, ev('/kb/x', { params: { id, revision: '1' } }))) as {
			revision: { title: string };
		};
		expect(ok.revision.title).toBe('Page');
	});

	it('page data holds names, never e-mail addresses or hashes', async () => {
		const id = await newPage();
		const data = await call(kbView.load, ev(`/kb/${id}`, { params: { id } }));
		const json = JSON.stringify(data);
		expect(json).toContain('Max Member');
		expect(json).not.toContain('@example.test');
		expect(json).not.toMatch(/hash|salt|password/i);
	});
});

describe('spaces', () => {
	it('an unknown or deleted project is 404; an archived one is shown', async () => {
		await insertProject(db, admin.id, { key: 'GONE', deletedAt: 1 });
		await insertProject(db, admin.id, { key: 'OLD', status: 'archived', name: 'Old one' });
		for (const key of ['NOPE', 'GONE', '1x', "O'R"])
			expect(status(await call(kbProject.load, ev('/kb/projects/x', { params: { key } })))).toBe(
				404
			);
		const old = (await call(
			kbProject.load,
			ev('/kb/projects/old', { params: { key: 'old' } })
		)) as {
			project: { status: string };
		};
		expect(old.project.status).toBe('archived');
	});
});

describe('create, preview and save', () => {
	it('creates a page from the form and redirects to it with a notice', async () => {
		const result = await call(
			kbNew.actions.create,
			ev('/kb/new?/create', {
				form: { title: '  Hello​ world ', body: 'Text', project: '', parentId: '' }
			})
		);
		expect(isRedirect(result)).toBe(true);
		const location = isRedirect(result) ? result.location : '';
		expect(location).toMatch(/^\/kb\/[0-9a-f-]{36}\?notice=created$/);
		const id = location.slice(4, 40);
		expect((await pageRow(db, id))?.title).toBe('Hello world');
	});

	it('refuses an empty title or a bad parent with field errors and echoes the input', async () => {
		const empty = await call(
			kbNew.actions.create,
			ev('/kb/new', { form: { title: '', body: 'kept', project: '', parentId: '' } })
		);
		expect(status(empty)).toBe(400);
		expect(isActionFailure(empty) && empty.data).toMatchObject({
			values: { body: 'kept' },
			errors: { title: 'Give the page a title.' }
		});
		const project = await insertProject(db, admin.id, { key: 'OPS' });
		const teamParent = await newPage('Team');
		const crossScope = await call(
			kbNew.actions.create,
			ev('/kb/new', { form: { title: 'x', body: '', project: project.key, parentId: teamParent } })
		);
		expect(status(crossScope)).toBe(400);
		expect(isActionFailure(crossScope) && crossScope.data).toMatchObject({
			errors: { parent: 'The parent page must be in the same space.' }
		});
		const unknownProject = await call(
			kbNew.actions.create,
			ev('/kb/new', { form: { title: 'x', body: '', project: 'ZZZ', parentId: '' } })
		);
		expect(status(unknownProject)).toBe(404);
	});

	it('the no-JS preview echoes the input without saving', async () => {
		const result = (await call(
			kbNew.actions.preview,
			ev('/kb/new?/preview', { form: { title: 'T', body: '# Heading', parentId: '' } })
		)) as { preview: string; values: { title: string } };
		expect(result.preview).toBe('# Heading');
		expect(result.values.title).toBe('T');
		expect(
			Number((await db.$client.prepare('select count(*) n from pages').first<{ n: number }>())?.n)
		).toBe(0);
	});

	it('a stale save answers 409 with both versions; resending with the new revision wins', async () => {
		const id = await newPage('Doc');
		await savePage(db, other, id, { title: 'Doc', body: 'theirs' }, 1, Date.now());
		const conflict = await call(
			kbEdit.actions.save,
			ev(`/kb/${id}/edit`, {
				params: { id },
				form: { title: 'Doc', body: 'mine', expectedRevision: '1' }
			})
		);
		expect(status(conflict)).toBe(409);
		expect(isActionFailure(conflict) && conflict.data).toMatchObject({
			values: { body: 'mine' },
			conflict: { revision: 2, body: 'theirs', editedByName: 'Olu Other' }
		});
		const over = await call(
			kbEdit.actions.save,
			ev(`/kb/${id}/edit`, {
				params: { id },
				form: { title: 'Doc', body: 'mine', expectedRevision: '2' }
			})
		);
		expect(isRedirect(over) && over.location).toBe(`/kb/${id}?notice=saved`);
		expect((await revisionsOf(db, id)).map((r) => r.body)).toEqual(['Body', 'theirs', 'mine']);
		const forged = await call(
			kbEdit.actions.save,
			ev(`/kb/${id}/edit`, {
				params: { id },
				form: { title: 'Doc', body: 'x', expectedRevision: 'abc' }
			})
		);
		expect(status(forged)).toBe(400);
	});

	it('restore from history redirects with the numbers; a stale form is 409', async () => {
		const id = await newPage('V1');
		await savePage(db, member, id, { title: 'V2', body: 'Body' }, 1, Date.now());
		const ok = await call(
			kbHistory.actions.restore,
			ev(`/kb/${id}/history`, { params: { id }, form: { revision: '1', expectedRevision: '2' } })
		);
		expect(isRedirect(ok) && ok.location).toBe(`/kb/${id}?notice=restored&from=1&to=3`);
		const stale = await call(
			kbRevision.actions.restore,
			ev(`/kb/${id}/history/2`, {
				params: { id, revision: '2' },
				form: { revision: '2', expectedRevision: '2' }
			})
		);
		expect(status(stale)).toBe(409);
		const missing = await call(
			kbHistory.actions.restore,
			ev(`/kb/${id}/history`, { params: { id }, form: { revision: '77', expectedRevision: '3' } })
		);
		expect(status(missing)).toBe(404);
	});
});

describe('move and delete', () => {
	it('a forged move under a descendant is refused and changes nothing', async () => {
		const a = await newPage('A');
		const b = await newPage('B', member, a);
		const before = await pageRow(db, a);
		const result = await call(
			kbMove.actions.move,
			ev(`/kb/${a}/move`, {
				params: { id: a },
				form: { scope: 'team', parentId: b, placement: 'last' }
			})
		);
		expect(status(result)).toBe(400);
		expect(await pageRow(db, a)).toEqual(before);
		const bad = await call(
			kbMove.actions.move,
			ev(`/kb/${a}/move`, {
				params: { id: a },
				form: { scope: 'team', parentId: 'zzz', placement: 'last' }
			})
		);
		expect(status(bad)).toBe(400);
	});

	it('moves into a project space and the move form lists only allowed parents', async () => {
		const project = await insertProject(db, admin.id, { key: 'OPS' });
		const a = await newPage('A');
		const child = await newPage('Child', member, a);
		const form = (await call(kbMove.load, ev(`/kb/${a}/move`, { params: { id: a } }))) as {
			parents: { value: string }[];
			scope: string;
		};
		expect(form.scope).toBe('team');
		expect(form.parents.map((p) => p.value)).not.toContain(a);
		expect(form.parents.map((p) => p.value)).not.toContain(child);
		const moved = await call(
			kbMove.actions.move,
			ev(`/kb/${a}/move`, {
				params: { id: a },
				form: { scope: 'OPS', parentId: '', placement: 'last' }
			})
		);
		expect(isRedirect(moved) && moved.location).toBe(`/kb/${a}?notice=moved`);
		expect((await pageRow(db, child))?.projectId).toBe(project.id);
		expect(
			status(await call(kbMove.load, ev(`/kb/${a}/move?scope=NOPE`, { params: { id: a } })))
		).toBe(404);
	});

	it('delete: a non-creator member gets 403, a missing confirm 400, the creator succeeds', async () => {
		const id = await newPage('Mine', member);
		const view = (await call(kbView.load, ev(`/kb/${id}`, { user: other, params: { id } }))) as {
			canDelete: boolean;
		};
		expect(view.canDelete).toBe(false);
		const forbidden = await call(
			kbDelete.actions.delete,
			ev(`/kb/${id}/delete`, { user: other, params: { id }, form: { confirm: 'yes' } })
		);
		expect(status(forbidden)).toBe(403);
		const unconfirmed = await call(
			kbDelete.actions.delete,
			ev(`/kb/${id}/delete`, { params: { id }, form: { confirm: '' } })
		);
		expect(status(unconfirmed)).toBe(400);
		expect((await pageRow(db, id))?.deletedAt).toBeNull();
		const done = await call(
			kbDelete.actions.delete,
			ev(`/kb/${id}/delete`, { params: { id }, form: { confirm: 'yes' } })
		);
		expect(isRedirect(done) && done.location).toBe('/kb?notice=deleted');
		expect(status(await call(kbView.load, ev(`/kb/${id}`, { params: { id } })))).toBe(404);
	});

	it('an admin may delete anyone’s page', async () => {
		const id = await newPage('Theirs', other);
		const done = await call(
			kbDelete.actions.delete,
			ev(`/kb/${id}/delete`, { user: admin, params: { id }, form: { confirm: 'yes' } })
		);
		expect(isRedirect(done)).toBe(true);
	});
});
