import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import {
	createComment,
	editComment,
	loadThread,
	type CommentTarget
} from '#lib/server/comments/service';
import { isCrossSiteForm } from '#lib/server/csrf';
import { getDb, type Db } from '#lib/server/db';
import { deletePage } from '#lib/server/kb/repo';
import { describeNotifications, listNotifications } from '#lib/server/notifications/repo';
import { deleteTask, getTaskByNumber } from '#lib/server/tasks/repo';
import { mentionMarkup, renderMarkdown } from '#lib/shared/markdown';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import {
	clearDiscussion,
	commentRows,
	notificationsOf,
	seedDiscussion,
	type Discussion
} from '../helpers/seed-discussion';
import { insertUser } from '../helpers/users';

/**
 * RB-03 red-team probes against a fresh local D1 with the real migrations. See
 * docs/features/rb-03-comments-notifications/SECURITY_REPORT.md. Tests named PROOF document a finding and pass while
 * it is open; flip their assertions when it is fixed. Every other test asserts behaviour that held.
 */

vi.mock('#lib/server/env', () => ({ getEnv: () => ({}) }));

const taskRoute = await import('../../src/routes/(app)/projects/[key]/tasks/[number]/+page.server');
const kbRoute = await import('../../src/routes/(app)/kb/[id]/+page.server');
const inbox = await import('../../src/routes/(app)/notifications/+page.server');
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
const location = (x: unknown) => (isRedirect(x) ? x.location : null);

const taskPath = () => `/projects/${s.project.key}/tasks/${s.task.number}`;
type CommentAction = 'commentCreate' | 'commentEdit' | 'commentDelete';
function onTask(action: CommentAction, user: SessionUser | null, form: Record<string, string>) {
	const { event } = fakeEvent({
		url: `http://localhost${taskPath()}?/${action}`,
		db,
		user: user ?? undefined,
		params: { key: s.project.key, number: String(s.task.number) },
		form
	});
	return call(taskRoute.actions[action], event);
}
function onPage(
	action: CommentAction,
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
const taskTarget = (): CommentTarget => ({ kind: 'task', id: s.task.id });
const pageTarget = (): CommentTarget => ({ kind: 'page', id: s.pageId });
async function post(user: SessionUser, body: string, target: CommentTarget = taskTarget()) {
	const r = await createComment(db, user, target, body, Date.now());
	if (!r.ok) throw new Error(`create failed: ${r.reason}`);
	return r.id;
}
const rowOf = async (targetId: string, id: string) =>
	(await commentRows(db, targetId)).find((r) => r.id === id);
const inboxOf = async (user: SessionUser) =>
	describeNotifications(
		db,
		(await listNotifications(db, user.id, { filter: 'all', before: null })).rows
	);
function api(user: SessionUser | null, q: string) {
	return call(
		mentionsApi.GET,
		fakeEvent({
			url: `http://localhost/api/mentions?q=${encodeURIComponent(q)}`,
			db,
			user: user ?? undefined
		}).event
	);
}

describe('authorization on comment actions', () => {
	it('a member cannot edit or delete another user’s comment; an admin cannot edit it either', async () => {
		const id = await post(s.author, 'original text');
		const row = await rowOf(s.task.id, id);
		const form = { commentId: id, body: 'hijacked', expectedUpdatedAt: String(row!.updatedAt) };
		expect(status(await onTask('commentEdit', s.bystander, form))).toBe(403);
		expect(status(await onTask('commentEdit', s.admin, form))).toBe(403);
		expect(status(await onTask('commentDelete', s.bystander, { commentId: id }))).toBe(403);
		expect(await rowOf(s.task.id, id)).toMatchObject({ body: 'original text', deletedAt: null });
		// Upper-case id: the same rule, not a bypass.
		expect(
			status(await onTask('commentEdit', s.bystander, { ...form, commentId: id.toUpperCase() }))
		).toBe(403);
		expect(status(await onTask('commentDelete', s.admin, { commentId: id }))).toBe(303);
		expect((await rowOf(s.task.id, id))!.deletedAt).not.toBeNull();
	});

	it('a 409 conflict body goes only to the author (a non-author gets 403 before any stored text)', async () => {
		const id = await post(s.author, 'secret draft');
		const r = await onTask('commentEdit', s.bystander, {
			commentId: id,
			body: 'x',
			expectedUpdatedAt: '1'
		});
		expect(status(r)).toBe(403);
		expect(JSON.stringify(r)).not.toContain('secret draft');
	});
});

describe('IDOR across targets and kinds', () => {
	it('a comment id from another target cannot be edited or deleted through this host (404, unchanged)', async () => {
		const onPageId = await post(s.author, 'page comment', pageTarget());
		const onTaskId = await post(s.author, 'task comment');
		const pageRow = await rowOf(s.pageId, onPageId);
		expect(
			status(
				await onTask('commentEdit', s.author, {
					commentId: onPageId,
					body: 'moved?',
					expectedUpdatedAt: String(pageRow!.updatedAt)
				})
			)
		).toBe(404);
		expect(status(await onTask('commentDelete', s.admin, { commentId: onPageId }))).toBe(404);
		expect(status(await onPage('commentDelete', s.admin, { commentId: onTaskId }))).toBe(404);
		expect(await rowOf(s.pageId, onPageId)).toMatchObject({
			body: 'page comment',
			deletedAt: null
		});
		expect(await rowOf(s.task.id, onTaskId)).toMatchObject({ deletedAt: null });
	});

	it('a task id posted as a page (and the reverse) is refused: the kind decides the table', async () => {
		expect(
			await createComment(db, s.author, { kind: 'page', id: s.task.id }, 'x', Date.now())
		).toEqual({ ok: false, reason: 'not_found' });
		expect(
			await createComment(db, s.author, { kind: 'task', id: s.pageId }, 'x', Date.now())
		).toEqual({ ok: false, reason: 'not_found' });
		// The KB host takes only page ids from its own route param.
		expect(status(await onPage('commentCreate', s.author, { body: 'x' }, s.task.id))).toBe(404);
		expect(await commentRows(db, s.task.id)).toEqual([]);
		expect(await commentRows(db, s.pageId)).toEqual([]);
	});

	it('a task or page of a soft-deleted project takes no comment, edit or delete', async () => {
		const id = await post(s.author, 'before');
		const row = await rowOf(s.task.id, id);
		await db.$client
			.prepare('UPDATE projects SET deleted_at = ?1 WHERE id = ?2')
			.bind(Date.now(), s.project.id)
			.run();
		expect(await createComment(db, s.author, taskTarget(), 'after', Date.now())).toEqual({
			ok: false,
			reason: 'not_found'
		});
		expect(
			await editComment(db, s.author, taskTarget(), id, 'edited', row!.updatedAt, Date.now())
		).toEqual({ ok: false, reason: 'not_found' });
		expect(await rowOf(s.task.id, id)).toMatchObject({ body: 'before' });
	});
});

describe('notifications: scoping', () => {
	it('mark read / mark all read touch only the caller’s rows, whatever id is posted', async () => {
		await post(s.author, `hi ${mentionMarkup(s.bystander)} ${mentionMarkup(s.creator)}`);
		const [victim] = (await listNotifications(db, s.bystander.id, { filter: 'all', before: null }))
			.rows;
		const ev = (user: SessionUser, form: Record<string, string>) =>
			fakeEvent({ url: 'http://localhost/notifications', db, user, form }).event;
		expect(status(await call(inbox.actions.read, ev(s.creator, { id: victim!.id })))).toBe(303);
		expect(status(await call(inbox.actions.readAll, ev(s.creator, {})))).toBe(303);
		expect((await notificationsOf(db, s.bystander.id)).every((n) => n.readAt === null)).toBe(true);
		expect((await notificationsOf(db, s.creator.id)).every((n) => n.readAt !== null)).toBe(true);
	});

	it('the inbox load reads the session user only; query parameters cannot name another user', async () => {
		// A page comment: the creator gets nothing of their own (pages notify mentions only).
		await post(s.author, `hi ${mentionMarkup(s.bystander)}`, pageTarget());
		const { event } = fakeEvent({
			url: `http://localhost/notifications?user=${s.bystander.id}&userId=${s.bystander.id}`,
			db,
			user: s.creator
		});
		const data = (await call(inbox.load, event)) as { items: unknown[] };
		expect(data.items).toEqual([]);
	});

	it('mark-read redirects never leave the site (filter/before rebuilt from parsed values)', async () => {
		for (const form of <Record<string, string>[]>[
			{ id: crypto.randomUUID(), filter: '//evil.example', before: 'https://evil.example' },
			{ filter: 'unread\r\nLocation: //evil.example', before: '1_x' }
		]) {
			const r = await call(
				inbox.actions.readAll,
				fakeEvent({ url: 'http://localhost/notifications', db, user: s.creator, form }).event
			);
			expect(location(r)).toMatch(/^\/notifications(\?filter=unread)?$/);
		}
		const id = await post(s.author, 'x');
		const r = await onTask('commentDelete', s.author, { commentId: id, cpage: '//evil.example' });
		expect(location(r)).toBe(`${taskPath()}#comments`);
	});
});

describe('/api/mentions', () => {
	it('lists active users only, id and name only, at most 8, never cached', async () => {
		for (let i = 0; i < 12; i++) await insertUser(db, { name: `Aaron Filler ${i}` });
		const r = (await api(s.bystander, '')) as Response;
		expect(r.status).toBe(200);
		expect(r.headers.get('cache-control')).toBe('private, no-store');
		const { users } = (await r.json()) as { users: Record<string, unknown>[] };
		expect(users.length).toBe(8);
		for (const u of users) expect(Object.keys(u).sort()).toEqual(['id', 'name']);
		const dee = (await ((await api(s.bystander, 'Dee')) as Response).json()) as {
			users: { id: string }[];
		};
		expect(dee.users.map((u) => u.id)).not.toContain(s.disabled.id);
		// The body is a JSON object, not a top-level array (no legacy JSON-array hijack surface).
		expect((await ((await api(s.bystander, 'a')) as Response).text()).startsWith('{')).toBe(true);
	});

	it('q is literal text (no LIKE wildcards), > 50 code points is a 400, signed out is 401', async () => {
		for (const q of ['%', '_', '%%', "' OR 1=1 --"]) {
			const { users } = (await ((await api(s.bystander, q)) as Response).json()) as {
				users: unknown[];
			};
			expect(users).toEqual([]);
		}
		expect(status(await api(s.bystander, 'x'.repeat(51)))).toBe(400);
		expect(status(await api(null, 'a'))).toBe(401);
	});

	it('e-mail addresses are not searchable through the name filter', async () => {
		const { users } = (await ((await api(s.bystander, '@example.test')) as Response).json()) as {
			users: unknown[];
		};
		expect(users).toEqual([]);
	});
});

describe('mentions: spoofing and spam', () => {
	it('a typed label never shows: thread HTML and the excerpt use the id’s real name', async () => {
		const spoof = `@[Ada Admin](user:${s.bystander.id}) approved this`;
		await post(s.author, spoof);
		const thread = await loadThread(
			db,
			s.creator,
			taskTarget(),
			new URL(`http://localhost${taskPath()}`)
		);
		const html = renderMarkdown(thread.comments[0]!.body, thread.names);
		expect(html).toContain('@Bo Bystander');
		expect(html).not.toContain('Ada Admin');
		const [n] = (await inboxOf(s.bystander)).filter((v) => v.kind === 'mention');
		expect(n!.excerpt).toContain('@Bo Bystander');
		expect(n!.excerpt).not.toContain('Ada Admin');
		// An unknown id shows "unknown user", not the label.
		const unknown = renderMarkdown(`@[Ada Admin](user:${crypto.randomUUID()})`, thread.names);
		expect(unknown).toContain('@unknown user');
	});

	it('a user whose name is markup is escaped in the chip, and an HTML label is never rendered', async () => {
		const evil = await insertUser(db, { name: '<img src=x onerror=alert(1)>' });
		await post(
			s.author,
			`${mentionMarkup(evil)} and @[<script>alert(1)</script>](user:${s.bystander.id})`
		);
		const thread = await loadThread(
			db,
			s.creator,
			taskTarget(),
			new URL(`http://localhost${taskPath()}`)
		);
		const html = renderMarkdown(thread.comments[0]!.body, thread.names);
		expect(html).not.toMatch(/<img|<script/i);
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
	});

	it('mass mentions: 60 distinct real users notify exactly 20; self and disabled never', async () => {
		const many: SessionUser[] = [];
		for (let i = 0; i < 60; i++) many.push(await insertUser(db, { name: `Crowd ${i}` }));
		const body = [s.author, s.disabled, ...many].map((u) => mentionMarkup(u)).join(' ');
		await post(s.author, body, pageTarget());
		const { results } = await db.$client
			.prepare(`SELECT user_id AS userId FROM notifications WHERE kind = 'mention'`)
			.all<{ userId: string }>();
		expect(results.length).toBe(20);
		const ids = new Set(results.map((r) => r.userId));
		expect(ids.has(s.author.id)).toBe(false);
		expect(ids.has(s.disabled.id)).toBe(false);
	});

	it('PROOF L1 (fixed): toggling a mention out and back in notifies the same user only once', async () => {
		const id = await post(s.author, `ping ${mentionMarkup(s.bystander)}`, pageTarget());
		for (let i = 0; i < 3; i++) {
			let row = await rowOf(s.pageId, id);
			expect(
				(await editComment(db, s.author, pageTarget(), id, `ping ${i}`, row!.updatedAt, Date.now()))
					.ok
			).toBe(true);
			row = await rowOf(s.pageId, id);
			expect(
				(
					await editComment(
						db,
						s.author,
						pageTarget(),
						id,
						`ping ${mentionMarkup(s.bystander)} ${i}`,
						row!.updatedAt,
						Date.now()
					)
				).ok
			).toBe(true);
		}
		// Fixed: one comment, one mention notification to that person, however often it is re-added.
		const mine = (await notificationsOf(db, s.bystander.id)).filter((n) => n.commentId === id);
		expect(mine.length).toBe(1);
	});
});

describe('races, throttle and caps', () => {
	it('two concurrent edits against the same version: exactly one wins, the other gets 409', async () => {
		const id = await post(s.author, 'v1');
		const row = await rowOf(s.task.id, id);
		const at = Date.now();
		const results = await Promise.all(
			['tab A', 'tab B'].map((b) =>
				editComment(db, s.author, taskTarget(), id, b, row!.updatedAt, at)
			)
		);
		expect(results.filter((r) => r.ok).length).toBe(1);
		expect(results.filter((r) => !r.ok && r.reason === 'conflict').length).toBe(1);
	});

	it('25 concurrent creates with distinct bodies: the 20/minute budget holds exactly', async () => {
		const at = Date.now();
		const results = await Promise.all(
			Array.from({ length: 25 }, (_, i) =>
				createComment(db, s.author, taskTarget(), `burst ${i}`, at)
			)
		);
		expect(results.filter((r) => r.ok).length).toBe(20);
		expect(results.filter((r) => !r.ok && r.reason === 'throttled').length).toBe(5);
		expect(await commentRows(db, s.task.id)).toHaveLength(20);
	});

	it('edits share the budget, so create+edit cannot exceed 20/minute', async () => {
		const id = await post(s.author, 'seed');
		for (let i = 0; i < 19; i++) {
			const row = await rowOf(s.task.id, id);
			expect(
				(await editComment(db, s.author, taskTarget(), id, `e${i}`, row!.updatedAt, Date.now())).ok
			).toBe(true);
		}
		const row = await rowOf(s.task.id, id);
		expect(
			await editComment(db, s.author, taskTarget(), id, 'over', row!.updatedAt, Date.now())
		).toEqual({ ok: false, reason: 'throttled' });
		expect(await createComment(db, s.author, taskTarget(), 'over', Date.now())).toEqual({
			ok: false,
			reason: 'throttled'
		});
	});

	it('a body past the 128 KiB form cap is a 400 without a write; 10 001 astral code points are refused', async () => {
		expect(status(await onTask('commentCreate', s.author, { body: 'x'.repeat(140_000) }))).toBe(
			400
		);
		expect(status(await onTask('commentCreate', s.author, { body: '😀'.repeat(10_001) }))).toBe(
			400
		);
		expect(await commentRows(db, s.task.id)).toEqual([]);
	});
});

describe('CSRF and content types', () => {
	it('cross-site and Origin-less form posts to the comment and inbox actions are refused by the hook rule', () => {
		const make = (origin: string | null, type = 'application/x-www-form-urlencoded') =>
			new Request(`https://ruby.example${taskPath()}?/commentCreate`, {
				method: 'POST',
				headers: { 'content-type': type, ...(origin ? { origin } : {}) },
				body: 'body=x'
			});
		expect(isCrossSiteForm(make('https://evil.example'), 'https://ruby.example')).toBe(true);
		expect(isCrossSiteForm(make(null), 'https://ruby.example')).toBe(true);
		expect(
			isCrossSiteForm(make('https://evil.example', 'text/plain'), 'https://ruby.example')
		).toBe(true);
		expect(isCrossSiteForm(make('https://ruby.example'), 'https://ruby.example')).toBe(false);
	});

	it('a non-form content type (which skips the origin rule) is refused by the action with 415', async () => {
		const { event } = fakeEvent({
			url: `http://localhost${taskPath()}?/commentCreate`,
			method: 'POST',
			db,
			user: s.author,
			params: { key: s.project.key, number: String(s.task.number) },
			headers: { 'content-type': 'application/json', origin: 'https://evil.example' }
		});
		expect(status(await call(taskRoute.actions.commentCreate, event))).toBe(415);
		expect(await commentRows(db, s.task.id)).toEqual([]);
	});
});

describe('soft delete in the inbox', () => {
	it('a deleted comment shows no excerpt (held)', async () => {
		const id = await post(s.author, `secret ${mentionMarkup(s.bystander)}`, pageTarget());
		await onPage('commentDelete', s.author, { commentId: id });
		const [n] = await inboxOf(s.bystander);
		expect(n).toMatchObject({ excerpt: null, commentDeleted: true });
	});

	it('PROOF M1 (fixed): a comment on a soft-deleted task shows no excerpt in the inbox', async () => {
		await post(s.author, `rotate the key hunter2-fictional ${mentionMarkup(s.bystander)}`);
		const task = await getTaskByNumber(db, s.project.id, s.task.number);
		await deleteTask(db, s.project, task!.id, Date.now());
		const [n] = (await inboxOf(s.bystander)).filter((v) => v.kind === 'mention');
		expect(n).toMatchObject({ targetTitle: null, href: null });
		// Fixed: the target is gone, so is the comment text.
		expect(n!.excerpt).toBeNull();
	});

	it('PROOF M1 (fixed): the same holds for a deleted page and for a task of a deleted project', async () => {
		await post(s.author, `page note pg-fictional ${mentionMarkup(s.bystander)}`, pageTarget());
		await deletePage(db, s.creator, s.pageId, Date.now());
		await post(s.author, `task note tk-fictional ${mentionMarkup(s.bystander)}`);
		await db.$client
			.prepare('UPDATE projects SET deleted_at = ?1 WHERE id = ?2')
			.bind(Date.now(), s.project.id)
			.run();
		const excerpts = (await inboxOf(s.bystander)).map((v) => v.excerpt ?? '');
		expect(excerpts.some((e) => e.includes('pg-fictional'))).toBe(false);
		expect(excerpts.some((e) => e.includes('tk-fictional'))).toBe(false);
	});
});
