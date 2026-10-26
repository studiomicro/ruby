import { isActionFailure, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { checkBody, checkTitle } from '#lib/server/kb/validation';
import { createPage } from '#lib/server/kb/repo';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { insertProject, pageRow } from '../helpers/seed-kb';
import { insertUser } from '../helpers/users';

const kbMove = await import('../../src/routes/(app)/kb/[id]/move/+page.server');

let db: Db;
let dispose: () => Promise<void>;
let user: SessionUser;
beforeAll(async () => {
	const o = await openLocalD1();
	db = getDb(o.db);
	dispose = o.dispose;
});
afterAll(() => dispose());
beforeEach(async () => {
	for (const t of [
		'page_revisions',
		'pages',
		'tasks',
		'projects',
		'sessions',
		'user_passwords',
		'users'
	])
		await db.run(sql.raw(`delete from ${t}`));
	user = await insertUser(db, { role: 'member', name: 'Qa Member' });
});

describe('RB-02 QA probes', () => {
	it('AC3 boundaries: title 1/200 ok, 201 refused; body 200000 ok, 200001 refused', () => {
		expect(checkTitle('a').error).toBeUndefined();
		expect(checkTitle('a'.repeat(200)).error).toBeUndefined();
		expect(checkTitle('a'.repeat(201)).error).toBeDefined();
		expect(checkTitle('  ​‮ ').error).toBeDefined();
		expect(checkTitle('a​b\nc').value).toBe('ab c');
		expect(checkBody('a'.repeat(200_000)).error).toBeUndefined();
		expect(checkBody('a'.repeat(200_001)).error).toBeDefined();
	});

	it('emoji title (200 code points) and 100k-emoji body are accepted', () => {
		expect(checkTitle('😀'.repeat(200)).error).toBeUndefined();
		expect(checkBody('😀'.repeat(100_000)).error).toBeUndefined(); // 100k chars < 200k
	});

	it('a project keyed TEAM is still a valid move target (scope is case-sensitive team)', async () => {
		const proj = await insertProject(db, user.id, { key: 'TEAM', name: 'Team Project' });
		const r = await createPage(
			db,
			user,
			{ title: 'P', body: '', parentId: null, projectId: null },
			Date.now()
		);
		if (!r.ok) throw new Error('x');
		const e = fakeEvent({
			url: `http://localhost/kb/${r.id}/move`,
			db,
			user,
			params: { id: r.id },
			form: { scope: 'TEAM', parentId: '', placement: 'last' }
		}).event;
		let res: unknown;
		try {
			res = await (kbMove.actions.move as (event: never) => unknown)(e as never);
		} catch (x) {
			res = x;
		}
		expect(isRedirect(res) || isActionFailure(res)).toBe(true);
		expect((await pageRow(db, r.id))?.projectId).toBe(proj.id);
	});
});
