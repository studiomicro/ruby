import { isHttpError } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { sessionCookieName } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { createPage } from '#lib/server/kb/repo';
import { ATTACHMENT_LIMITS } from '#lib/shared/attachments';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { spyR2 } from '../helpers/fake-r2';
import { insertProject, insertTask } from '../helpers/seed-kb';
import { insertSession, insertUser } from '../helpers/users';

/**
 * RB-04 cycle 2 red-team probes through the real handlers and hook, local D1 and the local R2 bucket only
 * (SECURITY_REPORT.md › Re-check after cycle 2): R2 multipart round trips, the size cap at part edges, aborts and part
 * failures mid-multipart, field order, the admin retention purge, and the rebased task/page loaders.
 */

const binding: Record<string, unknown> = { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' };
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const { handle } = await import('../../src/hooks.server');
const upload = await import('../../src/routes/(app)/files/+server');
const download = await import('../../src/routes/(app)/files/[id]/+server');
const retention = await import('../../src/routes/(app)/admin/attachments/+page.server');
const kbView = await import('../../src/routes/(app)/kb/[id]/+page.server');
const taskView = await import('../../src/routes/(app)/projects/[key]/tasks/[number]/+page.server');

let db: Db;
let dispose: () => Promise<void>;
let real: R2Bucket;
let r2: ReturnType<typeof spyR2>;
let admin: SessionUser;
let member: SessionUser;
let project: { id: string; key: string; name: string };
let task: { id: string };
let pageId: string;
const MiB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
/** Per-part failure injection on top of spyR2 (which has none for parts). */
const partFail = { at: 0 };

beforeAll(async () => {
	const opened = await openLocalD1();
	binding.DB = opened.db;
	db = getDb(opened.db);
	dispose = opened.dispose;
	real = opened.env.FILES;
	r2 = spyR2(real);
	const spied = r2.bucket;
	binding.FILES = new Proxy(spied, {
		get(target, prop) {
			if (prop !== 'createMultipartUpload') return Reflect.get(target, prop);
			return async (...args: Parameters<R2Bucket['createMultipartUpload']>) => {
				const up = await target.createMultipartUpload(...args);
				return {
					uploadPart: async (n: number, v: Parameters<R2MultipartUpload['uploadPart']>[1]) => {
						if (partFail.at === n) throw new Error('injected part failure');
						return up.uploadPart(n, v);
					},
					complete: (p: R2UploadedPart[]) => up.complete(p),
					abort: () => up.abort()
				};
			};
		}
	});
});
afterAll(() => dispose());
beforeEach(async () => {
	r2.reset();
	partFail.at = 0;
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'log').mockImplementation(() => {});
	for (const table of [
		'attachments',
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
	for (const o of (await real.list({ prefix: 'att/' })).objects) await real.delete(o.key);
	admin = await insertUser(db, { role: 'admin', name: 'Ada Admin' });
	member = await insertUser(db, { role: 'member', name: 'Max Member' });
	project = await insertProject(db, admin.id, { key: 'OPS' });
	task = await insertTask(db, project, admin.id, { number: 1, title: 'Fictional task' });
	const page = await createPage(
		db,
		member,
		{ title: 'Fictional page', body: 'Body', parentId: null, projectId: null },
		Date.now()
	);
	if (!page.ok) throw new Error('page');
	pageId = page.id;
});
afterEach(() => vi.restoreAllMocks());

async function call(fn: unknown, event: unknown): Promise<Response> {
	try {
		return (await (fn as (e: never) => Promise<Response>)(event as never)) as Response;
	} catch (e) {
		if (isHttpError(e)) return Response.json({ message: e.body.message }, { status: e.status });
		throw e;
	}
}

const enc = new TextEncoder();
/** Binary full of CRLF, `--` and near-boundaries. */
function hostile(n: number, boundary: string) {
	const out = new Uint8Array(n);
	const near = enc.encode(`\r\n--${boundary.slice(0, -1)}`);
	let seed = 1;
	for (let i = 0; i < n; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		out[i] = seed & 0xff;
	}
	for (let i = 0; i + near.length < n; i += 997) out.set(near, i);
	for (let i = 500; i + 4 < n; i += 1009) out.set(enc.encode('\r\n--'), i);
	// Overlaps can form the real delimiter, which would legitimately end the part: break each one.
	const full = Buffer.from(`\r\n--${boundary}`);
	const view = Buffer.from(out.buffer, out.byteOffset, out.length);
	for (let at = view.indexOf(full); at !== -1; at = view.indexOf(full, at))
		out[at + full.length - 1] = (out[at + full.length - 1] ?? 0) ^ 0x01;
	return out;
}

const BOUNDARY = '----RedTeamBoundaryX9';
function multipart(
	file: Uint8Array,
	opts: { fields?: [string, string][]; fileFirst?: boolean; name?: string } = {}
) {
	const fields = opts.fields ?? [
		['targetKind', 'task'],
		['targetId', task.id]
	];
	const f = (k: string, v: string) =>
		enc.encode(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
	const fileHead = enc.encode(
		`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${opts.name ?? 'data.bin'}"\r\n\r\n`
	);
	const tail = enc.encode(`\r\n--${BOUNDARY}--\r\n`);
	const pieces = opts.fileFirst
		? [
				fileHead,
				file,
				enc.encode('\r\n'),
				...fields.map(([k, v]) => f(k, v)),
				enc.encode(`--${BOUNDARY}--\r\n`)
			]
		: [...fields.map(([k, v]) => f(k, v)), fileHead, file, tail];
	const all = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of pieces) {
		all.set(p, at);
		at += p.length;
	}
	return all;
}

/** The body as a chunked stream (no Content-Length); `failAfter` errors the stream after that many bytes. */
function stream(
	all: Uint8Array,
	chunk = 64 * 1024,
	failAfter?: number,
	onAt?: { at: number; run: () => Promise<void> }
) {
	let at = 0;
	let ran = false;
	return new ReadableStream<Uint8Array>({
		async pull(c) {
			if (failAfter !== undefined && at >= failAfter) return c.error(new Error('client went away'));
			if (onAt && !ran && at >= onAt.at) {
				ran = true;
				await onAt.run();
			}
			if (at >= all.length) return c.close();
			c.enqueue(all.slice(at, at + chunk));
			at += chunk;
		}
	});
}

function uploadEvent(body: BodyInit, user: SessionUser = member) {
	const { event } = fakeEvent({
		url: 'http://localhost/files',
		method: 'POST',
		db,
		user,
		routeId: '/(app)/files'
	});
	Object.assign(event, {
		request: new Request('http://localhost/files', {
			method: 'POST',
			body,
			headers: {
				origin: 'http://localhost',
				accept: 'application/json',
				'content-type': `multipart/form-data; boundary=${BOUNDARY}`
			},
			duplex: 'half'
		} as RequestInit)
	});
	return event;
}

const post = (body: BodyInit, user?: SessionUser) => call(upload.POST, uploadEvent(body, user));
const rows = async () =>
	(
		await db.$client
			.prepare(
				'SELECT id, r2_key AS r2Key, deleted_at AS deletedAt, target_id AS targetId FROM attachments'
			)
			.all<{ id: string; r2Key: string; deletedAt: number | null; targetId: string }>()
	).results;
const objects = async () => (await real.list({ prefix: 'att/' })).objects.map((o) => o.key);

describe('R2 multipart path', () => {
	it('a 12 MiB hostile binary (3 parts) round trips byte for byte; parts are 5 MiB, 5 MiB, rest', async () => {
		const file = hostile(12 * MiB + 13, BOUNDARY);
		const res = await post(stream(multipart(file), 65_537));
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };
		expect(r2.calls.filter((c) => !c.startsWith('get'))).toEqual([
			expect.stringMatching(/^multipart att\//),
			'part 1',
			'part 2',
			'part 3',
			'complete'
		]);
		const dl = await call(
			download.GET,
			fakeEvent({
				url: `http://localhost/files/${id}`,
				db,
				user: member,
				params: { id },
				routeId: '/(app)/files/[id]'
			}).event
		);
		expect(dl.status).toBe(200);
		const got = new Uint8Array(await dl.arrayBuffer());
		expect(got.length).toBe(file.length);
		expect(Buffer.compare(Buffer.from(got), Buffer.from(file))).toBe(0);
	});

	it('exactly 25 MiB (5 full parts) is stored; 25 MiB + 1 byte is 413, the upload aborted, nothing left', async () => {
		const max = ATTACHMENT_LIMITS.maxBytes;
		const ok = await post(stream(multipart(new Uint8Array(max).fill(0x2d)), MiB));
		expect(ok.status).toBe(201);
		expect(r2.calls.filter((c) => c.startsWith('part'))).toHaveLength(5);
		await db.run(sql`delete from attachments`);
		for (const k of await objects()) await real.delete(k);
		r2.reset();
		const over = await post(stream(multipart(new Uint8Array(max + 1).fill(0x0d)), MiB));
		expect(over.status).toBe(413);
		expect(r2.calls).toContain('abort');
		expect(r2.calls).not.toContain('complete');
		expect(await rows()).toEqual([]);
		expect(await objects()).toEqual([]);
	});

	it('a client that goes away after 7 MiB: the multipart upload is aborted, no object, no row', async () => {
		const res = await post(stream(multipart(new Uint8Array(10 * MiB).fill(7)), MiB, 7 * MiB));
		expect(res.status).toBe(400);
		expect(r2.calls).toEqual([expect.stringMatching(/^multipart /), 'part 1', 'abort']);
		expect(await rows()).toEqual([]);
		expect(await objects()).toEqual([]);
	});

	it('a missing final boundary after 2 parts: aborted, not completed', async () => {
		const all = multipart(new Uint8Array(11 * MiB).fill(9));
		const cut = all.subarray(0, all.length - 8);
		const res = await post(stream(cut, MiB));
		expect(res.status).toBe(400);
		expect(r2.calls).toContain('abort');
		expect(r2.calls).not.toContain('complete');
		expect(await objects()).toEqual([]);
	});

	it('R2 refuses part 2: 503, the upload aborted, no row', async () => {
		partFail.at = 2;
		const res = await post(stream(multipart(new Uint8Array(11 * MiB).fill(1)), MiB));
		expect(res.status).toBe(503);
		expect(r2.calls).toContain('abort');
		expect(await rows()).toEqual([]);
		expect(await objects()).toEqual([]);
	});

	it('uploader disabled mid-multipart: completed object deleted again, 401', async () => {
		const res = await post(
			stream(multipart(new Uint8Array(11 * MiB).fill(3)), MiB, undefined, {
				at: 6 * MiB,
				run: async () => {
					await db.run(sql`UPDATE users SET status = 'disabled' WHERE id = ${member.id}`);
				}
			})
		);
		expect(res.status).toBe(401);
		expect(r2.calls).toContain('complete');
		expect(r2.calls.filter((c) => c.startsWith('delete'))).toHaveLength(1);
		expect(await rows()).toEqual([]);
		expect(await objects()).toEqual([]);
	});

	it('the file part before targetKind/targetId: 400 with no R2 call at all', async () => {
		const res = await post(stream(multipart(new Uint8Array(6 * MiB), { fileFirst: true }), MiB));
		expect(res.status).toBe(400);
		expect(r2.calls).toEqual([]);
	});

	it('a second file part after a 6 MiB first one: 400, first upload aborted', async () => {
		const first = multipart(new Uint8Array(6 * MiB).fill(4));
		const extra = enc.encode(
			`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="b"\r\n\r\nzz\r\n--${BOUNDARY}--\r\n`
		);
		const body = new Uint8Array(first.length - (BOUNDARY.length + 6) + extra.length);
		body.set(first.subarray(0, first.length - (BOUNDARY.length + 6)));
		body.set(extra, first.length - (BOUNDARY.length + 6));
		const res = await post(stream(body, MiB));
		expect(res.status).toBe(400);
		expect(r2.calls).toContain('abort');
		expect(await objects()).toEqual([]);
	});
});

describe('retention purge: authz, CSRF, bounds, targets', () => {
	const viaHook = async (init: { token?: string; origin?: string }) => {
		const resolve = vi.fn(async () => new Response('ran'));
		const url = 'http://localhost/admin/attachments?/purge';
		const { event } = fakeEvent({
			url,
			method: 'POST',
			db,
			routeId: '/(app)/admin/attachments',
			cookies: init.token ? { [sessionCookieName(false)]: init.token } : {}
		});
		const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
		if (init.origin) headers.origin = init.origin;
		Object.assign(event, {
			request: new Request(url, { method: 'POST', body: 'confirm=yes', headers })
		});
		const response = await handle({ event, resolve } as never);
		return { response, resolve };
	};

	it('a disabled admin’s live session and a cross-site post never reach the action', async () => {
		const token = await insertSession(db, admin.id);
		const cross = await viaHook({ token, origin: 'https://evil.example' });
		expect(cross.response.status).toBe(403);
		expect(cross.resolve).not.toHaveBeenCalled();
		const same = await viaHook({ token, origin: 'http://localhost' });
		expect(same.resolve).toHaveBeenCalled();
		await db.run(sql`UPDATE users SET status = 'disabled' WHERE id = ${admin.id}`);
		const disabled = await viaHook({ token, origin: 'http://localhost' });
		expect(disabled.resolve).not.toHaveBeenCalled();
		expect([401, 303]).toContain(disabled.response.status);
	});

	async function seed(n: number, kind: 'task' | 'page', targetId: string) {
		const keys: string[] = [];
		for (let i = 0; i < n; i++) {
			const key = `att/${crypto.randomUUID()}`;
			await real.put(key, 'x');
			await db.$client
				.prepare(
					`INSERT INTO attachments (id, target_kind, target_id, r2_key, filename, content_type, size_bytes, uploaded_by, created_at)
					 VALUES (?1, ?2, ?3, ?4, 'f.txt', 'text/plain', 1, ?5, ?6)`
				)
				.bind(crypto.randomUUID(), kind, targetId, key, member.id, Date.now())
				.run();
			keys.push(key);
		}
		return keys;
	}
	const purge = (user: SessionUser) =>
		(retention.actions.purge as (e: never) => Promise<unknown>)(
			fakeEvent({
				url: 'http://localhost/admin/attachments',
				db,
				user,
				form: { confirm: 'yes' },
				routeId: '/(app)/admin/attachments'
			}).event as never
		);

	it('batches of 100; 29.9 days is kept; a live task, a page in a live project and other targets are never touched', async () => {
		const now = Date.now();
		const deadTask = await insertTask(db, project, admin.id, { number: 2, title: 'dead' });
		const youngTask = await insertTask(db, project, admin.id, { number: 3, title: 'young' });
		const p2 = await insertProject(db, admin.id, { key: 'GONE' });
		const inDeadProject = await insertTask(db, p2, admin.id, { number: 1, title: 'x' });
		const projPage = await createPage(
			db,
			member,
			{ title: 'Proj page', body: 'b', parentId: null, projectId: p2.id },
			now
		);
		if (!projPage.ok) throw new Error('page');
		const archived = await insertProject(db, admin.id, { key: 'ARCH', status: 'archived' });
		const archTask = await insertTask(db, archived, admin.id, { number: 1, title: 'a' });

		const dead = await seed(130, 'task', deadTask.id);
		const young = await seed(2, 'task', youngTask.id);
		const live = await seed(2, 'task', task.id);
		const livePage = await seed(2, 'page', pageId);
		const deadProj = await seed(2, 'task', inDeadProject.id);
		const deadProjPage = await seed(2, 'page', projPage.id);
		const arch = await seed(2, 'task', archTask.id);
		await db.run(sql`update tasks set deleted_at = ${now - 31 * DAY} where id = ${deadTask.id}`);
		await db.run(
			sql`update tasks set deleted_at = ${now - 30 * DAY + 60_000} where id = ${youngTask.id}`
		);
		await db.run(sql`update projects set deleted_at = ${now - 45 * DAY} where id = ${p2.id}`);

		const member403 = await purge(member).catch((e: unknown) => e);
		expect(member403).toMatchObject({ status: 403 });

		const first = (await purge(admin)) as { purged: { purged: number; more: boolean } };
		expect(first.purged).toMatchObject({ purged: 100, more: true });
		const second = (await purge(admin)) as { purged: { purged: number; more: boolean } };
		expect(second.purged).toMatchObject({ purged: 34, more: false });

		const left = new Set(await objects());
		for (const k of [...dead, ...deadProj, ...deadProjPage]) expect(left.has(k)).toBe(false);
		for (const k of [...young, ...live, ...livePage, ...arch]) expect(left.has(k)).toBe(true);
		const tomb = (await rows()).filter((r) => r.deletedAt !== null).length;
		expect(tomb).toBe(134);
	});
});

describe('rebased loaders: comments and attachments on task and page', () => {
	it('both panels load for a member, carry no R2 key, and 404 once the parent is deleted', async () => {
		await seedOne();
		const kb = (await kbView.load(
			fakeEvent({
				url: `http://localhost/kb/${pageId}`,
				db,
				user: member,
				params: { id: pageId },
				routeId: '/(app)/kb/[id]'
			}).event as never
		)) as Record<string, unknown>;
		expect(kb).toHaveProperty('comments');
		expect(JSON.stringify(kb.attachments)).not.toMatch(/att\//);
		const tEvent = fakeEvent({
			url: 'http://localhost/projects/OPS/tasks/1',
			db,
			user: member,
			params: { key: 'OPS', number: '1' },
			routeId: '/(app)/projects/[key]/tasks/[number]'
		}).event;
		Object.assign(tEvent, { parent: async () => ({ project }) });
		const t = (await taskView.load(tEvent as never)) as Record<string, unknown>;
		expect(t).toHaveProperty('comments');
		expect((t.attachments as { items: unknown[] }).items).toHaveLength(1);
		expect(JSON.stringify(t)).not.toMatch(/att\//);
		const signedOut = fakeEvent({
			url: `http://localhost/kb/${pageId}`,
			db,
			params: { id: pageId },
			routeId: '/(app)/kb/[id]'
		}).event;
		await expect(kbView.load(signedOut as never)).rejects.toMatchObject({ status: 401 });
		await db.run(sql`update tasks set deleted_at = ${Date.now()} where id = ${task.id}`);
		await expect(taskView.load(tEvent as never)).rejects.toMatchObject({ status: 404 });
	});

	async function seedOne() {
		const res = await post(stream(multipart(enc.encode('hello'))));
		expect(res.status).toBe(201);
	}
});
