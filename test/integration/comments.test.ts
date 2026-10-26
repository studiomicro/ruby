import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import {
	createComment,
	editComment,
	loadThread,
	type CommentTarget
} from '#lib/server/comments/service';
import { getDb, type Db } from '#lib/server/db';
import { deletePage } from '#lib/server/kb/repo';
import {
	describeNotifications,
	listNotifications,
	markAllRead,
	markRead,
	unreadCount
} from '#lib/server/notifications/repo';
import { deleteTask, getTaskByNumber } from '#lib/server/tasks/repo';
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
import { archive } from '../helpers/seed-tasks';
import { insertUser } from '../helpers/users';

/** RB-03 end to end against local D1: the host pages' comment actions, the inbox, the badge and the picker API. */

// The task page imports RB-01's team-day helper, which reads the env module; no binding is needed here.
vi.mock('#lib/server/env', () => ({ getEnv: () => ({}) }));

const taskRoute = await import('../../src/routes/(app)/projects/[key]/tasks/[number]/+page.server');
const kbRoute = await import('../../src/routes/(app)/kb/[id]/+page.server');
const inbox = await import('../../src/routes/(app)/notifications/+page.server');
const layout = await import('../../src/routes/(app)/+layout.server');
const mentionsApi = await import('../../src/routes/api/mentions/+server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
let s: Discussion;

beforeAll(async () => {
	const opened = await openLocalD1();
	d1 = opened.db;
	db = getDb(opened.db);
	dispose = opened.dispose;
});
afterAll(() => dispose());
beforeEach(async () => {
	await clearDiscussion(db);
	s = await seedDiscussion(db);
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
const failData = (x: unknown) =>
	isActionFailure(x) ? (x.data as unknown as { comment: Record<string, unknown> }).comment : null;

const taskParams = () => ({ key: s.project.key, number: String(s.task.number) });
const taskPath = () => `/projects/${s.project.key}/tasks/${s.task.number}`;

function onTask(
	action: 'commentCreate' | 'commentEdit' | 'commentDelete',
	user: SessionUser | null,
	form: Record<string, string>
) {
	const { event } = fakeEvent({
		url: `http://localhost${taskPath()}?/${action}`,
		db,
		user: user ?? undefined,
		params: taskParams(),
		form
	});
	return call(taskRoute.actions[action], event);
}
function onPage(
	action: 'commentCreate' | 'commentEdit' | 'commentDelete',
	user: SessionUser | null,
	form: Record<string, string>,
	id = s.pageId
) {
	const { event } = fakeEvent({
		url: `http://localhost/kb/${id}?/${action}`,
		db,
		user: user ?? undefined,
		params: { id },
		form
	});
	return call(kbRoute.actions[action], event);
}
const mention = (u: SessionUser) => mentionMarkup(u);
const taskTarget = (): CommentTarget => ({ kind: 'task', id: s.task.id });
const pageTarget = (): CommentTarget => ({ kind: 'page', id: s.pageId });

async function post(user: SessionUser, body: string, target: CommentTarget = taskTarget()) {
	const r = await createComment(db, user, target, body, Date.now());
	if (!r.ok) throw new Error(`create failed: ${r.reason}`);
	return r.id;
}

describe('access', () => {
	it('signed out: every comment action, the inbox, its actions and /api/mentions answer 401', async () => {
		for (const action of ['commentCreate', 'commentEdit', 'commentDelete'] as const) {
			expect(status(await onTask(action, null, { body: 'x' }))).toBe(401);
			expect(status(await onPage(action, null, { body: 'x' }))).toBe(401);
		}
		const ev = (form?: Record<string, string>) =>
			fakeEvent({ url: 'http://localhost/notifications', db, form }).event;
		expect(status(await call(inbox.load, ev()))).toBe(401);
		expect(status(await call(inbox.actions.read, ev({ id: s.task.id })))).toBe(401);
		expect(status(await call(inbox.actions.readAll, ev({})))).toBe(401);
		const api = fakeEvent({ url: 'http://localhost/api/mentions?q=a', db }).event;
		expect(status(await call(mentionsApi.GET, api))).toBe(401);
		expect(await commentRows(db, s.task.id)).toEqual([]);
	});
});

describe('create', () => {
	it('posts on a live task and a live page and redirects to the comment', async () => {
		const r = await onTask('commentCreate', s.author, { body: 'First **note**' });
		expect(status(r)).toBe(303);
		const [row] = await commentRows(db, s.task.id);
		expect(row).toMatchObject({ authorId: s.author.id, body: 'First **note**', deletedAt: null });
		expect(isRedirect(r) && r.location).toBe(`${taskPath()}#comment-${row!.id}`);

		const p = await onPage('commentCreate', s.author, { body: 'On the page' });
		const [pageRow] = await commentRows(db, s.pageId);
		expect(isRedirect(p) && p.location).toBe(`/kb/${s.pageId}#comment-${pageRow!.id}`);
	});

	it('refuses deleted, missing and malformed targets with 404 and writes nothing', async () => {
		const task = await getTaskByNumber(db, s.project.id, s.task.number);
		await deleteTask(db, s.project, task!.id, Date.now());
		expect(status(await onTask('commentCreate', s.author, { body: 'late' }))).toBe(404);
		const { event } = fakeEvent({
			url: `http://localhost/projects/${s.project.key}/tasks/999?/commentCreate`,
			db,
			user: s.author,
			params: { key: s.project.key, number: '999' },
			form: { body: 'x' }
		});
		expect(status(await call(taskRoute.actions.commentCreate, event))).toBe(404);
		expect(status(await onPage('commentCreate', s.author, { body: 'x' }, 'not-a-uuid'))).toBe(404);
		expect(
			status(await onPage('commentCreate', s.author, { body: 'x' }, crypto.randomUUID()))
		).toBe(404);
		await deletePage(db, s.creator, s.pageId, Date.now());
		expect(status(await onPage('commentCreate', s.author, { body: 'late' }))).toBe(404);
		// The service refuses a gone target too (the guarded INSERT, not only the pre-read).
		expect(await createComment(db, s.author, pageTarget(), 'x', Date.now())).toEqual({
			ok: false,
			reason: 'not_found'
		});
		expect(await commentRows(db, s.task.id)).toEqual([]);
		expect(await commentRows(db, s.pageId)).toEqual([]);
	});

	it('body bounds: empty, whitespace-only and 10 001 refused (text kept); 1 and 10 000 accepted', async () => {
		for (const body of ['', '   \n ', 'a'.repeat(10_001)]) {
			const r = await onTask('commentCreate', s.author, { body });
			expect(status(r)).toBe(400);
			expect(failData(r)).toMatchObject({ action: 'create', body });
		}
		expect(status(await onTask('commentCreate', s.author, { body: 'k' }))).toBe(303);
		expect(status(await onTask('commentCreate', s.author, { body: 'b'.repeat(10_000) }))).toBe(303);
		expect(await commentRows(db, s.task.id)).toHaveLength(2);
	});

	it('comments on a task of an archived project are allowed', async () => {
		await archive(db, s.project.id);
		expect(status(await onTask('commentCreate', s.author, { body: 'still talking' }))).toBe(303);
	});

	it('a double submit (same body, same author, within seconds) returns the first comment', async () => {
		const a = await onTask('commentCreate', s.author, { body: 'twice' });
		const b = await onTask('commentCreate', s.author, { body: 'twice' });
		expect(isRedirect(a) && isRedirect(b) && a.location === b.location).toBe(true);
		expect(await commentRows(db, s.task.id)).toHaveLength(1);
	});

	it('the comment-create throttle answers 429, writes nothing and keeps the text', async () => {
		// Pinned to the start of a minute: with the real clock the 21 posts could straddle two per-minute windows.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000 + 1_000);
		try {
			await twentyThenLimited();
		} finally {
			vi.useRealTimers();
		}
	});

	async function twentyThenLimited() {
		for (let i = 0; i < 20; i++)
			expect(status(await onTask('commentCreate', s.author, { body: `n${i}` }))).toBe(303);
		const r = await onTask('commentCreate', s.author, { body: 'one too many' });
		expect(status(r)).toBe(429);
		expect(failData(r)).toMatchObject({ body: 'one too many' });
		expect(await commentRows(db, s.task.id)).toHaveLength(20);
		// Another user has a budget of their own.
		expect(status(await onTask('commentCreate', s.bystander, { body: 'mine' }))).toBe(303);
	}

	it('25 concurrent creates by one user: exactly 20 are written (the per-minute cap holds)', async () => {
		const at = Date.now();
		const results = await Promise.all(
			Array.from({ length: 25 }, (_, i) =>
				createComment(db, s.author, taskTarget(), `burst ${i}`, at)
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(20);
		expect(results.filter((r) => !r.ok && r.reason === 'throttled')).toHaveLength(5);
		expect(await commentRows(db, s.task.id)).toHaveLength(20);
	});

	it('a comment and its notifications are atomic: a failing notification insert leaves no comment', async () => {
		await d1
			.prepare(
				`CREATE TRIGGER fail_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'forced'); END`
			)
			.run();
		try {
			await expect(
				createComment(db, s.author, taskTarget(), `hey ${mention(s.bystander)}`, Date.now())
			).rejects.toThrow();
			expect(await commentRows(db, s.task.id)).toEqual([]);
		} finally {
			await d1.prepare('DROP TRIGGER fail_notification').run();
		}
	});
});

describe('notification fan-out', () => {
	it('a mention of an active user notifies them once; self, disabled, unknown and malformed ids notify nobody', async () => {
		const unknown = crypto.randomUUID();
		const body = [
			mention(s.bystander),
			mention(s.bystander),
			mention(s.bystander),
			mention(s.author),
			mention(s.disabled),
			`@[Ghost](user:${unknown})`,
			'@[Bad](user:not-a-uuid)'
		].join(' ');
		const id = await post(s.author, body, pageTarget());
		expect(await notificationsOf(db, s.bystander.id)).toEqual([
			{
				kind: 'mention',
				actorId: s.author.id,
				targetKind: 'page',
				targetId: s.pageId,
				commentId: id,
				readAt: null
			}
		]);
		for (const u of [s.author, s.disabled, s.creator])
			expect(await notificationsOf(db, u.id)).toEqual([]);
	});

	it('more than 20 distinct mentions notify only the first 20', async () => {
		const people = await Promise.all(
			Array.from({ length: 22 }, (_, i) => insertUser(db, { name: `Many ${i}` }))
		);
		await post(s.author, people.map(mention).join(' '), pageTarget());
		const { results } = await d1
			.prepare(`SELECT user_id FROM notifications WHERE kind = 'mention'`)
			.all<{ user_id: string }>();
		expect(results).toHaveLength(20);
		expect(new Set(results.map((r) => r.user_id))).toEqual(
			new Set(people.slice(0, 20).map((p) => p.id))
		);
	});

	it('a task comment notifies its assignee and creator (comment), never the author; mention wins', async () => {
		await post(s.author, 'plain');
		expect((await notificationsOf(db, s.assignee.id)).map((n) => n.kind)).toEqual(['comment']);
		expect((await notificationsOf(db, s.creator.id)).map((n) => n.kind)).toEqual(['comment']);
		expect(await notificationsOf(db, s.author.id)).toEqual([]);

		await post(s.author, `ping ${mention(s.assignee)}`);
		expect((await notificationsOf(db, s.assignee.id)).map((n) => n.kind)).toEqual([
			'comment',
			'mention'
		]);
		expect((await notificationsOf(db, s.creator.id)).map((n) => n.kind)).toEqual([
			'comment',
			'comment'
		]);

		// The creator commenting on their own task notifies only the assignee.
		await post(s.creator, 'from the creator');
		expect(await notificationsOf(db, s.creator.id)).toHaveLength(2);
		expect(await notificationsOf(db, s.assignee.id)).toHaveLength(3);
	});

	it('a page comment notifies only mentioned users (not the page creator)', async () => {
		await post(s.author, 'nobody mentioned', pageTarget());
		expect(await notificationsOf(db, s.creator.id)).toEqual([]);
	});

	it('an edit notifies only newly mentioned users, never with comment; an edit without new mentions notifies nobody', async () => {
		const id = await post(s.author, `hi ${mention(s.bystander)}`, pageTarget());
		const [row] = await commentRows(db, s.pageId);
		const e1 = await editComment(
			db,
			s.author,
			pageTarget(),
			id,
			`hi ${mention(s.bystander)} and ${mention(s.creator)}`,
			row!.updatedAt,
			Date.now()
		);
		expect(e1.ok).toBe(true);
		expect((await notificationsOf(db, s.creator.id)).map((n) => n.kind)).toEqual(['mention']);
		expect(await notificationsOf(db, s.bystander.id)).toHaveLength(1);
		const [after] = await commentRows(db, s.pageId);
		await editComment(
			db,
			s.author,
			pageTarget(),
			id,
			'removed them all',
			after!.updatedAt,
			Date.now()
		);
		expect(await notificationsOf(db, s.creator.id)).toHaveLength(1);
		expect(await notificationsOf(db, s.bystander.id)).toHaveLength(1);
	});

	it('editing a task comment sends no comment notifications', async () => {
		const id = await post(s.author, 'v1');
		const [row] = await commentRows(db, s.task.id);
		await editComment(db, s.author, taskTarget(), id, 'v2', row!.updatedAt, Date.now());
		expect(await notificationsOf(db, s.assignee.id)).toHaveLength(1);
	});
});

describe('edit and delete', () => {
	it('the author edits; a stale version is 409 with the stored text; others, admins included, get 403', async () => {
		const id = await post(s.author, 'original');
		const [row] = await commentRows(db, s.task.id);
		const form = (body: string, expected: number) => ({
			commentId: id,
			body,
			expectedUpdatedAt: String(expected)
		});
		expect(status(await onTask('commentEdit', s.bystander, form('hijack', row!.updatedAt)))).toBe(
			403
		);
		expect(status(await onTask('commentEdit', s.admin, form('hijack', row!.updatedAt)))).toBe(403);
		const ok = await onTask('commentEdit', s.author, form('edited text', row!.updatedAt));
		expect(isRedirect(ok) && ok.location).toBe(`${taskPath()}#comment-${id}`);
		const [edited] = await commentRows(db, s.task.id);
		expect(edited).toMatchObject({ body: 'edited text' });
		expect(edited!.updatedAt).toBeGreaterThan(edited!.createdAt);

		const stale = await onTask('commentEdit', s.author, form('from an old tab', row!.updatedAt));
		expect(status(stale)).toBe(409);
		expect(failData(stale)).toMatchObject({
			action: 'edit',
			id,
			body: 'from an old tab',
			current: 'edited text',
			expectedUpdatedAt: edited!.updatedAt
		});

		const thread = await loadThread(db, s.bystander, taskTarget(), new URL('http://localhost/'));
		expect(thread.comments[0]).toMatchObject({ edited: true, canEdit: false, canDelete: false });
		const admins = await loadThread(db, s.admin, taskTarget(), new URL('http://localhost/'));
		expect(admins.comments[0]).toMatchObject({ canEdit: false, canDelete: true });
	});

	it('edit refuses a comment of another target, a deleted one and a malformed id with 404', async () => {
		const onPageId = await post(s.author, 'page note', pageTarget());
		const [row] = await commentRows(db, s.pageId);
		const form = { commentId: onPageId, body: 'x', expectedUpdatedAt: String(row!.updatedAt) };
		expect(status(await onTask('commentEdit', s.author, form))).toBe(404);
		expect(status(await onTask('commentEdit', s.author, { ...form, commentId: 'nope' }))).toBe(404);
		await onPage('commentDelete', s.author, { commentId: onPageId });
		expect(status(await onPage('commentEdit', s.author, form))).toBe(404);
	});

	it('author or admin deletes; another member gets 403 and nothing changes; deleted comments vanish', async () => {
		const a = await post(s.author, 'by author');
		const b = await post(s.author, 'second by author');
		expect(status(await onTask('commentDelete', s.bystander, { commentId: a }))).toBe(403);
		expect((await commentRows(db, s.task.id)).every((c) => c.deletedAt === null)).toBe(true);
		expect(status(await onTask('commentDelete', s.author, { commentId: a }))).toBe(303);
		expect(status(await onTask('commentDelete', s.admin, { commentId: b }))).toBe(303);
		// Idempotent.
		expect(status(await onTask('commentDelete', s.author, { commentId: a }))).toBe(303);
		const thread = await loadThread(db, s.author, taskTarget(), new URL('http://localhost/'));
		expect(thread.total).toBe(0);
		expect(thread.comments).toEqual([]);
		// The rows stay (soft delete), and so do their notifications.
		expect((await commentRows(db, s.task.id)).every((c) => c.deletedAt !== null)).toBe(true);
		expect(await notificationsOf(db, s.assignee.id)).toHaveLength(2);
	});
});

describe('thread', () => {
	it('lists oldest first, 100 per page, with mention names from the users table', async () => {
		const at = Date.now() - 60_000;
		const stmts = Array.from({ length: 105 }, (_, i) =>
			d1
				.prepare(
					`INSERT INTO comments (id, target_kind, target_id, author_id, body, created_at, updated_at)
					 VALUES (?1, 'task', ?2, ?3, ?4, ?5, ?5)`
				)
				.bind(
					crypto.randomUUID(),
					s.task.id,
					s.author.id,
					`c${i} @[Fake](user:${s.bystander.id})`,
					at + i
				)
		);
		await d1.batch(stmts);
		const first = await loadThread(db, s.author, taskTarget(), new URL('http://localhost/'));
		expect(first).toMatchObject({ page: 1, pageCount: 2, total: 105 });
		expect(first.comments).toHaveLength(100);
		expect(first.comments[0]!.body.startsWith('c0 ')).toBe(true);
		expect(first.names.get(s.bystander.id)).toBe('Bo Bystander');
		const second = await loadThread(
			db,
			s.author,
			taskTarget(),
			new URL('http://localhost/?cpage=9')
		);
		expect(second.page).toBe(2);
		expect(second.comments.map((c) => c.body.split(' ')[0])).toEqual([
			'c100',
			'c101',
			'c102',
			'c103',
			'c104'
		]);
		// A new comment on page 2 redirects there.
		const r = await onTask('commentCreate', s.bystander, { body: 'late' });
		expect(isRedirect(r) && r.location).toMatch(/\?cpage=2#comment-/);
	});

	it('?cedit= opens only the viewer’s own comment', async () => {
		const id = await post(s.author, 'mine');
		const url = new URL(`http://localhost/?cedit=${id}`);
		expect((await loadThread(db, s.author, taskTarget(), url)).editingId).toBe(id);
		expect((await loadThread(db, s.admin, taskTarget(), url)).editingId).toBeNull();
	});

	it('the KB page load carries the thread', async () => {
		await post(s.author, 'on the page', pageTarget());
		const { event } = fakeEvent({
			url: `http://localhost/kb/${s.pageId}`,
			db,
			user: s.bystander,
			params: { id: s.pageId }
		});
		const data = (await call(kbRoute.load, event)) as { comments: { total: number } };
		expect(data.comments.total).toBe(1);
	});
});

describe('inbox', () => {
	it('shows only the viewer’s rows, with wording, links and the RB-01 assigned rows', async () => {
		const id = await post(s.author, `see ${mention(s.assignee)} **now**`);
		// RB-01 wrote an `assigned` row when the seed created the task assigned to Asa.
		const { event } = fakeEvent({ url: 'http://localhost/notifications', db, user: s.assignee });
		const data = (await call(inbox.load, event)) as {
			items: Awaited<ReturnType<typeof describeNotifications>>;
		};
		const ref = `${s.project.key}-${s.task.number}`;
		expect(data.items.map((n) => [n.actorName, n.verb, n.targetTitle, n.href, n.excerpt])).toEqual([
			[
				'Ari Author',
				'mentioned you in a comment on',
				`${ref} Fix the fictional login`,
				`${taskPath()}#comment-${id}`,
				'see @Asa Assignee now'
			],
			['Cleo Creator', 'assigned you', `${ref} Fix the fictional login`, taskPath(), null]
		]);
		const other = fakeEvent({ url: 'http://localhost/notifications', db, user: s.bystander }).event;
		expect(((await call(inbox.load, other)) as { items: unknown[] }).items).toEqual([]);
	});

	it('rows for a deleted comment or target render safely', async () => {
		const onPageId = await post(s.author, mention(s.bystander), pageTarget());
		await post(s.author, `x ${mention(s.bystander)}`);
		await onPage('commentDelete', s.author, { commentId: onPageId });
		const task = await getTaskByNumber(db, s.project.id, s.task.number);
		await deleteTask(db, s.project, task!.id, Date.now());
		const { rows } = await listNotifications(db, s.bystander.id, { filter: 'all', before: null });
		const views = await describeNotifications(db, rows);
		const byKind = Object.fromEntries(
			views.map((v) => [v.targetTitle === null ? 'gone' : 'page', v])
		);
		expect(byKind.gone).toMatchObject({
			href: null,
			targetTitle: null,
			excerpt: null,
			commentDeleted: false
		});
		expect(byKind.page).toMatchObject({
			href: `/kb/${s.pageId}`,
			commentDeleted: true,
			excerpt: null
		});
	});

	it('no comment text reaches the inbox once its task, page or project is soft-deleted (red team M1)', async () => {
		const excerpts = async (user: SessionUser) => {
			const { rows } = await listNotifications(db, user.id, { filter: 'all', before: null });
			return (await describeNotifications(db, rows)).map((v) => v.excerpt);
		};
		await post(s.author, `task secret ${mention(s.bystander)}`);
		await post(s.author, `page secret ${mention(s.bystander)}`, pageTarget());
		// A page inside the project, to see the project's deletion reach pages too.
		const { createPage } = await import('#lib/server/kb/repo');
		const inProject = await createPage(
			db,
			s.creator,
			{ title: 'Project page', body: '', projectId: s.project.id, parentId: null },
			Date.now()
		);
		if (!inProject.ok) throw new Error(inProject.error);
		await post(s.author, `project page secret ${mention(s.creator)}`, {
			kind: 'page',
			id: inProject.id
		});
		expect((await excerpts(s.bystander)).filter(Boolean)).toHaveLength(2);
		expect((await excerpts(s.creator)).filter(Boolean)).toHaveLength(2);

		// Page deleted: its comment text goes; the task's stays.
		await deletePage(db, s.creator, s.pageId, Date.now());
		expect(await excerpts(s.bystander)).toEqual([null, 'task secret @Bo Bystander']); // newest first
		// Task deleted.
		const task = await getTaskByNumber(db, s.project.id, s.task.number);
		await deleteTask(db, s.project, task!.id, Date.now());
		expect(await excerpts(s.bystander)).toEqual([null, null]);
		// Project deleted: its pages' comments go too.
		expect(await excerpts(s.creator)).toContain('project page secret @Cleo Creator');
		await d1
			.prepare('UPDATE projects SET deleted_at = ?1 WHERE id = ?2')
			.bind(Date.now(), s.project.id)
			.run();
		expect((await excerpts(s.creator)).filter(Boolean)).toEqual([]);
	});

	it('a mention of a deactivated user shows their name marked "(deactivated)"', async () => {
		await post(s.author, `cc ${mention(s.disabled)} ${mention(s.bystander)}`);
		const thread = await loadThread(db, s.author, taskTarget(), new URL('http://localhost/'));
		expect(thread.names.get(s.disabled.id)).toBe('Dee Disabled (deactivated)');
		expect(thread.names.get(s.bystander.id)).toBe('Bo Bystander');
		const [view] = await describeNotifications(
			db,
			(await listNotifications(db, s.bystander.id, { filter: 'all', before: null })).rows
		);
		expect(view!.excerpt).toBe('cc @Dee Disabled (deactivated) @Bo Bystander');
	});

	it('describeNotifications issues a fixed number of queries whatever the row count', async () => {
		let prepared = 0;
		const counting = new Proxy(d1, {
			get(target, prop) {
				if (prop === 'prepare')
					return (query: string) => {
						prepared += 1;
						return target.prepare(query);
					};
				const value = Reflect.get(target, prop);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const countingDb = getDb(counting);
		const measure = async () => {
			const { rows } = await listNotifications(db, s.bystander.id, { filter: 'all', before: null });
			prepared = 0;
			await describeNotifications(countingDb, rows);
			return { rows: rows.length, queries: prepared };
		};
		await post(s.author, mention(s.bystander), pageTarget());
		const one = await measure();
		for (let i = 0; i < 12; i++)
			await post(
				s.author,
				`${i} ${mention(s.bystander)} ${mention(s.creator)}`,
				i % 2 ? pageTarget() : taskTarget()
			);
		const many = await measure();
		expect(one.rows).toBe(1);
		expect(many.rows).toBe(13);
		expect(many.queries).toBe(one.queries + 1); // the task lookup joins in once tasks appear
		expect(many.queries).toBeLessThanOrEqual(5);
	});

	it('filter=unread and a 30-row cursor with equal timestamps: no duplicates, no skips', async () => {
		const at = Date.now();
		await d1.batch(
			Array.from({ length: 35 }, (_, i) =>
				d1
					.prepare(
						`INSERT INTO notifications (id, user_id, kind, actor_id, target_kind, target_id, created_at, read_at)
						 VALUES (?1, ?2, 'assigned', ?3, 'task', ?4, ?5, ?6)`
					)
					.bind(crypto.randomUUID(), s.bystander.id, s.author.id, s.task.id, at, i < 5 ? at : null)
			)
		);
		const p1 = await listNotifications(db, s.bystander.id, { filter: 'all', before: null });
		expect(p1.rows).toHaveLength(30);
		expect(p1.next).not.toBeNull();
		const { event } = fakeEvent({
			url: `http://localhost/notifications?before=${encodeURIComponent(p1.next!)}`,
			db,
			user: s.bystander
		});
		const p2 = (await call(inbox.load, event)) as { items: { id: string }[]; next: string | null };
		expect(p2.items).toHaveLength(5);
		expect(p2.next).toBeNull();
		const ids = [...p1.rows.map((r) => r.id), ...p2.items.map((r) => r.id)];
		expect(new Set(ids).size).toBe(35);
		const unread = await listNotifications(db, s.bystander.id, { filter: 'unread', before: null });
		expect(unread.rows).toHaveLength(30);
		expect(unread.rows.every((r) => r.readAt === null)).toBe(true);
	});

	it('mark read and mark all touch only the viewer’s rows, even with forged ids; both idempotent', async () => {
		await post(s.author, `${mention(s.bystander)} ${mention(s.creator)}`, pageTarget());
		const [mine] = (await listNotifications(db, s.bystander.id, { filter: 'all', before: null }))
			.rows;
		const [theirs] = (await listNotifications(db, s.creator.id, { filter: 'all', before: null }))
			.rows;
		const read = (user: SessionUser, form: Record<string, string>) =>
			call(
				inbox.actions.read,
				fakeEvent({ url: 'http://localhost/notifications?/read', db, user, form }).event
			);
		expect(status(await read(s.bystander, { id: theirs!.id }))).toBe(303);
		expect(await unreadCount(db, s.creator.id)).toBe(1);
		const done = await read(s.bystander, { id: mine!.id, filter: 'unread' });
		expect(isRedirect(done) && done.location).toBe('/notifications?filter=unread');
		expect(await unreadCount(db, s.bystander.id)).toBe(0);
		expect(await markRead(db, s.bystander.id, mine!.id, Date.now())).toBe(false);
		expect(status(await read(s.bystander, { id: 'forged' }))).toBe(404);

		expect(await markAllRead(db, s.bystander.id, Date.now())).toBe(0);
		expect(await unreadCount(db, s.creator.id)).toBe(1);
		const all = await call(
			inbox.actions.readAll,
			fakeEvent({ url: 'http://localhost/notifications?/readAll', db, user: s.creator, form: {} })
				.event
		);
		expect(isRedirect(all) && all.location).toBe('/notifications');
		expect(await unreadCount(db, s.creator.id)).toBe(0);
	});

	it('the layout badge counts unread rows up to 100', async () => {
		const badge = async (user: SessionUser) =>
			(
				(await call(layout.load, fakeEvent({ url: 'http://localhost/', db, user }).event)) as {
					unread: number;
				}
			).unread;
		expect(await badge(s.bystander)).toBe(0);
		await d1.batch(
			Array.from({ length: 120 }, (_, i) =>
				d1
					.prepare(
						`INSERT INTO notifications (id, user_id, kind, actor_id, target_kind, target_id, created_at)
						 VALUES (?1, ?2, 'assigned', ?3, 'task', ?4, ?5)`
					)
					.bind(crypto.randomUUID(), s.bystander.id, s.author.id, s.task.id, i)
			)
		);
		expect(await badge(s.bystander)).toBe(100);
		await markAllRead(db, s.bystander.id, Date.now());
		expect(await badge(s.bystander)).toBe(0);
	});
});

describe('/api/mentions', () => {
	const get = async (q: string, user: SessionUser | null = s.author) => {
		const r = await call(
			mentionsApi.GET,
			fakeEvent({
				url: `http://localhost/api/mentions?q=${encodeURIComponent(q)}`,
				db,
				user: user ?? undefined
			}).event
		);
		return r;
	};

	it('returns at most 8 active users, id and name only, prefix matches first, never cached', async () => {
		for (let i = 0; i < 10; i++) await insertUser(db, { name: `Zed Bo ${i}` });
		const r = (await get('bo')) as Response;
		expect(r.headers.get('cache-control')).toBe('private, no-store');
		const { users } = (await r.json()) as { users: Record<string, string>[] };
		expect(users).toHaveLength(8);
		expect(users[0]).toEqual({ id: s.bystander.id, name: 'Bo Bystander' });
		expect(users.every((u) => Object.keys(u).sort().join() === 'id,name')).toBe(true);
	});

	it('60 lookups a minute per user, then 429 with Retry-After (red team L2)', async () => {
		// Pinned to the start of a minute: with the real clock the 61 requests could straddle two minute windows.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000 + 1_000);
		try {
			await sixtyThenLimited();
		} finally {
			vi.useRealTimers();
		}
	});

	async function sixtyThenLimited() {
		for (let i = 0; i < 60; i++) expect(status(await get(`a${i}`))).toBe(200);
		const over = (await get('a')) as Response;
		expect(over.status).toBe(429);
		expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
		expect(Number(over.headers.get('retry-after'))).toBeLessThanOrEqual(60);
		// Another user has a budget of their own.
		expect(status(await get('a', s.bystander))).toBe(200);
	}

	it('excludes disabled users; empty q lists everyone active; q over 50 characters is 400', async () => {
		const dee = (await ((await get('dee')) as Response).json()) as { users: unknown[] };
		expect(dee.users).toEqual([]);
		const all = (await ((await get('')) as Response).json()) as { users: unknown[] };
		expect(all.users).toHaveLength(5);
		expect(status(await get('a'.repeat(51)))).toBe(400);
		expect(status(await get('a'.repeat(50)))).toBe(200);
		expect(status(await get(`%' OR 1=1 --`))).toBe(200);
	});
});
