import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { mentionNames } from '#lib/server/auth/users';
import {
	createComment,
	editComment,
	loadThread,
	type CommentTarget
} from '#lib/server/comments/service';
import { MENTION_SEARCH_PER_MINUTE } from '#lib/server/comments/mentions';
import { COMMENT_MESSAGES, parseCommentBody } from '#lib/server/comments/validation';
import { getDb, type Db } from '#lib/server/db';
import { createPage, deletePage, restoreRevision, savePage, getPage } from '#lib/server/kb/repo';
import { describeNotifications, listNotifications } from '#lib/server/notifications/repo';
import { deleteTask, moveTask } from '#lib/server/tasks/repo';
import { mentionMarkup } from '#lib/shared/markdown';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import {
	clearDiscussion,
	commentRows,
	notificationsOf,
	seedDiscussion,
	type Discussion
} from '../helpers/seed-discussion';
import { seedProject } from '../helpers/seed-tasks';

/**
 * RB-03 red-team re-check after cycle 2 (see SECURITY_REPORT.md › "Re-check after cycle 2"). Every test asserts
 * behaviour that held, except the one named INFO, which documents a by-design gap.
 */

vi.mock('#lib/server/env', () => ({ getEnv: () => ({}) }));
const mentionsApi = await import('../../src/routes/api/mentions/+server');

let db: Db;
let dispose: () => Promise<void>;
let s: Discussion;

beforeAll(async () => {
	const opened = await openLocalD1();
	db = getDb(opened.db);
	dispose = opened.dispose;
});
afterAll(() => dispose());
beforeEach(async () => {
	await clearDiscussion(db);
	s = await seedDiscussion(db);
});

const page = (id: string): CommentTarget => ({ kind: 'page', id });
const task = (): CommentTarget => ({ kind: 'task', id: s.task.id });
async function post(user: SessionUser, body: string, target: CommentTarget) {
	const r = await createComment(db, user, target, body, Date.now());
	if (!r.ok) throw new Error(`create failed: ${r.reason}`);
	return r.id;
}
async function newPage(title: string, parentId: string | null, projectId: string | null = null) {
	const r = await createPage(db, s.creator, { title, body: 'b', projectId, parentId }, Date.now());
	if (!r.ok) throw new Error(r.error);
	return r.id;
}
const inboxOf = async (user: SessionUser) =>
	describeNotifications(
		db,
		(await listNotifications(db, user.id, { filter: 'all', before: null })).rows
	);
const excerptsOf = async (user: SessionUser) => (await inboxOf(user)).map((n) => n.excerpt ?? '');
async function api(user: SessionUser, q = 'b', database: Db = db) {
	try {
		return (await mentionsApi.GET(
			fakeEvent({
				url: `http://localhost/api/mentions?q=${encodeURIComponent(q)}`,
				db: database,
				user
			}).event as never
		)) as Response;
	} catch (e) {
		return e as Response;
	}
}

describe('M1: no excerpt once the target is gone', () => {
	it('deleting a parent page hides excerpts of comments on its child and grandchild', async () => {
		const parent = await newPage('Parent', null);
		const child = await newPage('Child', parent);
		const grand = await newPage('Grandchild', child);
		await post(s.author, `child-secret ${mentionMarkup(s.bystander)}`, page(child));
		await post(s.author, `grand-secret ${mentionMarkup(s.bystander)}`, page(grand));
		await post(s.author, `parent-secret ${mentionMarkup(s.bystander)}`, page(parent));
		expect((await excerptsOf(s.bystander)).filter((e) => e.includes('-secret')).length).toBe(3);

		// Deleting only the grandchild hides only its excerpt.
		expect((await deletePage(db, s.creator, grand, Date.now())).kind).toBe('deleted');
		let ex = await excerptsOf(s.bystander);
		expect(ex.some((e) => e.includes('grand-secret'))).toBe(false);
		expect(ex.some((e) => e.includes('child-secret'))).toBe(true);

		expect((await deletePage(db, s.creator, parent, Date.now())).kind).toBe('deleted');
		ex = await excerptsOf(s.bystander);
		expect(ex.some((e) => e.includes('-secret'))).toBe(false);
		for (const n of await inboxOf(s.bystander))
			expect(n).toMatchObject({
				excerpt: null,
				href: null,
				targetTitle: null,
				commentDeleted: false
			});
	});

	it('a deleted project hides excerpts of its whole page tree and its tasks; archived stays visible', async () => {
		const project = await seedProject(db, s.creator, { name: 'Tree project' });
		const root = await newPage('Root', null, project.id);
		const leaf = await newPage('Leaf', root, project.id);
		await post(s.author, `leaf-secret ${mentionMarkup(s.bystander)}`, page(leaf));
		await post(s.author, `root-secret ${mentionMarkup(s.bystander)}`, page(root));

		await db.$client
			.prepare(`UPDATE projects SET status = 'archived' WHERE id = ?1`)
			.bind(project.id)
			.run();
		// Archived projects are live (owner decision 3).
		expect((await excerptsOf(s.bystander)).filter((e) => e.includes('-secret')).length).toBe(2);

		await db.$client
			.prepare('UPDATE projects SET deleted_at = ?1 WHERE id = ?2')
			.bind(Date.now(), project.id)
			.run();
		expect((await excerptsOf(s.bystander)).some((e) => e.includes('-secret'))).toBe(false);
	});

	it('restoring a revision of a live page keeps the excerpt; a deleted page cannot be restored back', async () => {
		const id = await newPage('Revised', null);
		expect(
			(await savePage(db, s.creator, id, { title: 'Revised', body: 'v2' }, 1, Date.now())).kind
		).toBe('saved');
		await post(s.author, `rev-secret ${mentionMarkup(s.bystander)}`, page(id));
		const restored = await restoreRevision(db, s.creator, id, 1, 2, Date.now());
		expect(restored.kind).toBe('saved');
		expect((await excerptsOf(s.bystander)).some((e) => e.includes('rev-secret'))).toBe(true);

		await deletePage(db, s.creator, id, Date.now());
		const current = 3;
		expect((await restoreRevision(db, s.creator, id, 1, current, Date.now())).kind).toBe(
			'not-found'
		);
		expect(await getPage(db, id)).toBeNull();
		expect((await excerptsOf(s.bystander)).some((e) => e.includes('rev-secret'))).toBe(false);
	});

	it('a task moved between states keeps its excerpt; deleted afterwards, it shows none', async () => {
		await post(s.author, `move-secret ${mentionMarkup(s.bystander)}`, task());
		for (const status of ['in_progress', 'done', 'todo'] as const) {
			const r = await moveTask(db, s.project, s.task.id, status, { place: 'top' }, Date.now());
			expect(r.ok).toBe(true);
			expect((await excerptsOf(s.bystander)).some((e) => e.includes('move-secret'))).toBe(true);
		}
		await deleteTask(db, s.project, s.task.id, Date.now());
		const rows = await inboxOf(s.bystander);
		expect(rows.some((n) => (n.excerpt ?? '').includes('move-secret'))).toBe(false);
		// The assignee's and creator's `comment` rows are gone too.
		for (const u of [s.assignee, s.creator])
			for (const n of await inboxOf(u)) expect(n.excerpt).toBeNull();
	});
});

describe('L1: one mention notification per user per comment', () => {
	it('five concurrent edits that all re-add the mention: one wins, one notification', async () => {
		const id = await post(s.author, `hi ${mentionMarkup(s.bystander)}`, page(s.pageId));
		let [row] = (await commentRows(db, s.pageId)).filter((r) => r.id === id);
		expect(
			(await editComment(db, s.author, page(s.pageId), id, 'hi', row!.updatedAt, Date.now())).ok
		).toBe(true);
		[row] = (await commentRows(db, s.pageId)).filter((r) => r.id === id);
		const results = await Promise.all(
			[0, 1, 2, 3, 4].map((i) =>
				editComment(
					db,
					s.author,
					page(s.pageId),
					id,
					`hi ${mentionMarkup(s.bystander)} ${i}`,
					row!.updatedAt,
					Date.now()
				)
			)
		);
		expect(results.filter((r) => r.ok).length).toBe(1);
		const mine = (await notificationsOf(db, s.bystander.id)).filter((n) => n.commentId === id);
		expect(mine.length).toBe(1);
	});

	it('no one but the author can edit, so no other actor can re-trigger the mention', async () => {
		const id = await post(s.author, `hi ${mentionMarkup(s.bystander)}`, page(s.pageId));
		const [row] = (await commentRows(db, s.pageId)).filter((r) => r.id === id);
		for (const other of [s.admin, s.creator]) {
			const r = await editComment(
				db,
				other,
				page(s.pageId),
				id,
				`x ${mentionMarkup(s.bystander)} ${mentionMarkup(s.assignee)}`,
				row!.updatedAt,
				Date.now()
			);
			expect(r).toMatchObject({ ok: false, reason: 'forbidden' });
		}
		expect((await notificationsOf(db, s.bystander.id)).length).toBe(1);
		expect((await notificationsOf(db, s.assignee.id)).length).toBe(0);
	});

	it('INFO: dedupe is per kind; an edit that mentions the task assignee adds a mention row next to the comment row', async () => {
		const id = await post(s.author, 'plain comment', task());
		const [row] = (await commentRows(db, s.task.id)).filter((r) => r.id === id);
		const r = await editComment(
			db,
			s.author,
			task(),
			id,
			`plain comment ${mentionMarkup(s.assignee)}`,
			row!.updatedAt,
			Date.now()
		);
		expect(r.ok).toBe(true);
		const kinds = (await notificationsOf(db, s.assignee.id))
			.filter((n) => n.commentId === id)
			.map((n) => n.kind)
			.sort();
		expect(kinds).toEqual(['comment', 'mention']);
	});
});

describe('L2: mention-search throttle', () => {
	it('60 lookups a minute, then 429 with Retry-After and no-store; another user keeps its own budget', async () => {
		for (let i = 0; i < MENTION_SEARCH_PER_MINUTE; i++)
			expect((await api(s.author)).status).toBe(200);
		const over = await api(s.author);
		expect(over.status).toBe(429);
		expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
		expect(Number(over.headers.get('retry-after'))).toBeLessThanOrEqual(60);
		expect(over.headers.get('cache-control')).toBe('private, no-store');
		expect(await over.json()).toEqual({ error: 'Too many lookups, wait a moment.' });
		expect((await api(s.bystander)).status).toBe(200);
		// The picker budget is not the comment budget.
		expect(
			(await createComment(db, s.author, page(s.pageId), 'still allowed', Date.now())).ok
		).toBe(true);
	});

	it('fails closed: a throttle store that throws gives 429, never an unthrottled lookup', async () => {
		const broken = new Proxy({} as Db, {
			get: () => {
				throw new Error('d1 down');
			}
		});
		const r = await api(s.author, 'b', broken);
		expect(r.status).toBe(429);
	});
});

describe('raw body cap (40 000 UTF-16 units) before cleaning', () => {
	const astral = '\u{1F600}';
	it('astral edges: 10 000 astral + padding up to exactly 40 000 units is cleaned; one unit more is refused', () => {
		const body = astral.repeat(10_000);
		expect(body.length).toBe(20_000);
		const pad = '\u0001'.repeat(20_000);
		expect(parseCommentBody(body + pad)).toEqual({ ok: true, value: body });
		expect(parseCommentBody(body + pad + '\u0001')).toEqual({
			ok: false,
			error: COMMENT_MESSAGES.tooLong
		});
		expect(parseCommentBody(astral.repeat(10_001))).toMatchObject({ ok: false });
		expect(parseCommentBody(astral.repeat(20_000))).toMatchObject({ ok: false });
	});

	it('CRLF, BMP multi-byte and a lone surrogate at the cut never yield a cut body', () => {
		const crlf = 'ä\r\n'.repeat(13_333) + 'x'; // 39 999 + 1 = 40 000 units, 26 667 code points after cleaning
		expect(crlf.length).toBe(40_000);
		expect(parseCommentBody(crlf)).toEqual({ ok: false, error: COMMENT_MESSAGES.tooLong });
		const half = 'a'.repeat(39_999) + '\uD83D';
		expect(parseCommentBody(half)).toMatchObject({ ok: false });
		expect(parseCommentBody('a'.repeat(39_999) + astral)).toMatchObject({ ok: false });
		const ok = 'é'.repeat(9_999) + astral;
		expect(parseCommentBody(ok)).toEqual({ ok: true, value: ok });
	});
});

describe('markDeactivated', () => {
	it('only the flagged callers get the suffix; the default is unchanged', async () => {
		expect((await mentionNames(db, [s.disabled.id])).get(s.disabled.id)).toBe('Dee Disabled');
		expect(
			(await mentionNames(db, [s.disabled.id], { markDeactivated: true })).get(s.disabled.id)
		).toBe('Dee Disabled (deactivated)');
		expect(
			(await mentionNames(db, [s.bystander.id], { markDeactivated: true })).get(s.bystander.id)
		).toBe('Bo Bystander');
		await post(s.author, `cc ${mentionMarkup(s.disabled)}`, page(s.pageId));
		const thread = await loadThread(db, s.author, page(s.pageId), new URL('http://localhost/kb/x'));
		expect(thread.names.get(s.disabled.id)).toBe('Dee Disabled (deactivated)');
	});
});
