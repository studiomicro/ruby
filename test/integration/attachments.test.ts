import { isHttpError } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isProtectedRoute } from '#lib/server/auth/gate';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { attachmentPanel } from '#lib/server/attachments/panel';
import { createPage } from '#lib/server/kb/repo';
import { ATTACHMENT_LIMITS } from '#lib/shared/attachments';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { spyR2 } from '../helpers/fake-r2';
import { insertProject, insertTask } from '../helpers/seed-kb';
import { insertUser } from '../helpers/users';

/**
 * RB-04 end to end through the route handlers, against local D1 and the local R2 bucket from openLocalD1 (wrapped
 * by spyR2 for a call log and injected failures). Nothing remote is touched.
 */

const binding: { DB?: D1Database; FILES?: R2Bucket } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const upload = await import('../../src/routes/(app)/files/+server');
const download = await import('../../src/routes/(app)/files/[id]/+server');
const remove = await import('../../src/routes/(app)/files/[id]/delete/+server');
const kbView = await import('../../src/routes/(app)/kb/[id]/+page.server');
const retention = await import('../../src/routes/(app)/admin/attachments/+page.server');

let db: Db;
let dispose: () => Promise<void>;
let real: R2Bucket;
let r2: ReturnType<typeof spyR2>;
let admin: SessionUser;
let member: SessionUser;
let other: SessionUser;
let task: { id: string };
let taskPath: string;
let pageId: string;
const logs: unknown[][] = [];

beforeAll(async () => {
	const opened = await openLocalD1();
	binding.DB = opened.db;
	db = getDb(opened.db);
	dispose = opened.dispose;
	real = opened.env.FILES;
	r2 = spyR2(real);
	binding.FILES = r2.bucket;
});
afterAll(() => dispose());
beforeEach(async () => {
	r2.reset();
	logs.length = 0;
	for (const level of ['log', 'warn', 'error', 'info'] as const)
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			logs.push(args);
		});
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
	admin = await insertUser(db, { role: 'admin', name: 'Ada Admin' });
	member = await insertUser(db, { role: 'member', name: 'Max Member' });
	other = await insertUser(db, { role: 'member', name: 'Olu Other' });
	const project = await insertProject(db, admin.id, { key: 'OPS' });
	task = await insertTask(db, project, admin.id, { number: 1, title: 'Fictional task' });
	taskPath = '/projects/OPS/tasks/1';
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

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2, 3, 4
]);

type Target = { kind?: string; id?: string };
interface UploadInit {
	user?: SessionUser | null;
	target?: Target;
	file?: File | null;
	files?: File[];
	json?: boolean;
	returnTo?: string;
	headers?: Record<string, string>;
}

function uploadEvent(init: UploadInit = {}) {
	const form = new FormData();
	form.set('targetKind', init.target?.kind ?? 'task');
	form.set('targetId', init.target?.id ?? task.id);
	if (init.returnTo !== undefined) form.set('returnTo', init.returnTo);
	for (const f of init.files ?? [
		init.file === undefined ? new File(['hello'], 'a.txt') : init.file
	])
		if (f) form.append('file', f);
	const { event } = fakeEvent({
		url: 'http://localhost/files',
		method: 'POST',
		db,
		user: init.user === undefined ? member : (init.user ?? undefined),
		routeId: '/(app)/files'
	});
	const headers: Record<string, string> = { origin: 'http://localhost', ...init.headers };
	if (init.json !== false) headers.accept = 'application/json';
	Object.assign(event, {
		request: new Request('http://localhost/files', { method: 'POST', body: form, headers })
	});
	return event;
}

async function call(fn: (e: never) => unknown, event: unknown): Promise<Response> {
	try {
		return (await fn(event as never)) as Response;
	} catch (e) {
		if (isHttpError(e)) return Response.json({ message: e.body.message }, { status: e.status });
		throw e;
	}
}

const send = (init: UploadInit = {}) => call(upload.POST as never, uploadEvent(init));

function downloadEvent(
	id: string,
	init: { user?: SessionUser | null; query?: string; headers?: Record<string, string> } = {}
) {
	return fakeEvent({
		url: `http://localhost/files/${id}${init.query ?? ''}`,
		db,
		user: init.user === undefined ? member : (init.user ?? undefined),
		params: { id },
		headers: init.headers,
		routeId: '/(app)/files/[id]'
	}).event;
}
const get = (id: string, init: Parameters<typeof downloadEvent>[1] = {}) =>
	call(download.GET as never, downloadEvent(id, init));

function deleteEvent(
	id: string,
	user: SessionUser | null,
	form: Record<string, string>,
	json = true
) {
	return fakeEvent({
		url: `http://localhost/files/${id}/delete`,
		db,
		user: user ?? undefined,
		params: { id },
		form,
		headers: json ? { accept: 'application/json' } : {},
		routeId: '/(app)/files/[id]/delete'
	}).event;
}
const del = (
	id: string,
	user: SessionUser | null = member,
	form: Record<string, string> = { confirm: 'yes' },
	json = true
) => call(remove.POST as never, deleteEvent(id, user, form, json));

async function rows() {
	const { results } = await db.$client
		.prepare(
			`SELECT id, r2_key AS r2Key, filename, content_type AS contentType, size_bytes AS sizeBytes,
				deleted_at AS deletedAt FROM attachments ORDER BY created_at`
		)
		.all<{
			id: string;
			r2Key: string;
			filename: string;
			contentType: string;
			sizeBytes: number;
			deletedAt: number | null;
		}>();
	return results;
}
async function objects(): Promise<string[]> {
	const listed = await real.list({ prefix: 'att/' });
	return listed.objects.map((o) => o.key);
}
async function clearBucket() {
	for (const key of await objects()) await real.delete(key);
}
beforeEach(clearBucket);

/** Writes `n` live rows straight into D1 for `target` (no R2 objects; only the cap is under test). */
async function seedRows(
	n: number,
	target: { kind: string; id: string } = { kind: 'task', id: task.id },
	deleted = false
) {
	for (let i = 0; i < n; i++)
		await db.$client
			.prepare(
				`INSERT INTO attachments (id, target_kind, target_id, r2_key, filename, content_type, size_bytes, uploaded_by, created_at, deleted_at)
				 VALUES (?1, ?2, ?3, ?4, 'seed.txt', 'text/plain', 1, ?5, ?6, ?7)`
			)
			.bind(
				crypto.randomUUID(),
				target.kind,
				target.id,
				`att/${crypto.randomUUID()}`,
				member.id,
				Date.now(),
				deleted ? Date.now() : null
			)
			.run();
}

async function uploaded(init: UploadInit = {}) {
	const res = await send(init);
	expect(res.status).toBe(201);
	return (await res.json()) as {
		id: string;
		filename: string;
		sizeBytes: number;
		contentType: string;
	};
}

describe('signed out', () => {
	it('upload, download and delete are refused and return no bytes', async () => {
		const { id } = await uploaded();
		r2.calls.length = 0;
		expect((await send({ user: null })).status).toBe(401);
		const res = await get(id, { user: null });
		expect(res.status).toBe(401);
		expect(await res.text()).not.toContain('hello');
		expect((await del(id, null)).status).toBe(401);
		expect(r2.calls).toEqual([]);
		expect(await rows()).toHaveLength(1);
		// And hooks.server.ts answers these routes before any handler runs (auth gate).
		for (const route of ['/(app)/files', '/(app)/files/[id]', '/(app)/files/[id]/delete'])
			expect(isProtectedRoute(route)).toBe(true);
	});
});

describe('upload', () => {
	it('stores a 1-byte file: R2 first, then the row, with a server-made key', async () => {
		const body = await uploaded({ file: new File(['x'], 'one.txt', { type: 'text/html' }) });
		expect(body).toMatchObject({ filename: 'one.txt', sizeBytes: 1, contentType: 'text/plain' });
		const [row] = await rows();
		expect(row?.r2Key).toMatch(/^att\/[0-9a-f-]{36}$/);
		expect(await objects()).toEqual([row?.r2Key]);
		expect(r2.calls).toEqual([`put ${row?.r2Key}`]);
	});

	it('accepts exactly 25 MB and refuses one byte more with nothing stored', async () => {
		const max = ATTACHMENT_LIMITS.maxBytes;
		await uploaded({ file: new File([new Uint8Array(max)], 'max.bin') });
		const [row] = await rows();
		expect(row?.sizeBytes).toBe(max);
		r2.calls.length = 0;
		const res = await send({ file: new File([new Uint8Array(max + 1)], 'big.bin') });
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({ error: 'too_large' });
		expect(await rows()).toHaveLength(1);
		// The parts streamed before the extra byte arrived were aborted with the upload: nothing stored.
		expect(r2.calls[0]).toMatch(/^multipart att\//);
		expect(r2.calls.at(-1)).toBe('abort');
		expect(r2.calls.filter((c) => c === 'complete' || c.startsWith('put'))).toEqual([]);
		expect(await objects()).toEqual([row?.r2Key]);
	});

	it('an empty file is 422', async () => {
		const res = await send({ file: new File([], 'empty.txt') });
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({ error: 'empty' });
		expect(await rows()).toEqual([]);
	});

	it('an oversized Content-Length is refused before the body is read', async () => {
		let pulled = false;
		const event = uploadEvent();
		Object.assign(event, {
			request: new Request('http://localhost/files', {
				method: 'POST',
				duplex: 'half',
				body: new ReadableStream({ pull: () => void (pulled = true) }, { highWaterMark: 0 }),
				headers: {
					origin: 'http://localhost',
					accept: 'application/json',
					'content-type': 'multipart/form-data; boundary=x',
					'content-length': String(
						ATTACHMENT_LIMITS.maxBytes + ATTACHMENT_LIMITS.bodyOverheadBytes + 1
					)
				}
			} as RequestInit)
		});
		const res = await call(upload.POST as never, event);
		expect(res.status).toBe(413);
		expect(pulled).toBe(false);
		expect(r2.calls).toEqual([]);
	});

	it('the 21st upload is 409 and its R2 object is removed', async () => {
		await seedRows(20);
		const res = await send();
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: 'limit' });
		expect(r2.calls).toEqual([]); // the pre-check refuses before any put
		expect(await objects()).toEqual([]);
	});

	it('20 concurrent uploads to a target with 19 live files: exactly one succeeds', async () => {
		await seedRows(19);
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) => send({ file: new File([`n${i}`], `f${i}.txt`) }))
		);
		const statuses = results.map((r) => r.status).sort();
		expect(statuses.filter((s) => s === 201)).toHaveLength(1);
		expect(statuses.filter((s) => s === 409)).toHaveLength(19);
		const live = (await rows()).filter((r) => r.deletedAt === null);
		expect(live).toHaveLength(20);
		// Every losing upload's object was deleted again: only the winner's is left.
		const winner = live.find((r) => r.filename.startsWith('f'));
		expect(await objects()).toEqual([winner?.r2Key]);
	});

	it('tombstoned attachments do not count toward 20', async () => {
		await seedRows(19);
		await seedRows(5, undefined, true);
		await uploaded();
		expect((await send()).status).toBe(409);
	});

	it.each([
		['an unknown task', () => ({ kind: 'task', id: crypto.randomUUID() })],
		['an unknown page', () => ({ kind: 'page', id: crypto.randomUUID() })],
		['a page id named as a task', () => ({ kind: 'task', id: pageId })]
	])('upload to %s is 404 and stores nothing', async (_, target) => {
		const res = await send({ target: target() });
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ error: 'target_gone' });
		expect(r2.calls).toEqual([]);
		expect(await rows()).toEqual([]);
	});

	it('upload to a deleted task, a deleted page or a task of a deleted project is 404', async () => {
		await db.run(sql`update tasks set deleted_at = 1 where id = ${task.id}`);
		expect((await send()).status).toBe(404);
		await db.run(sql`update pages set deleted_at = 1 where id = ${pageId}`);
		expect((await send({ target: { kind: 'page', id: pageId } })).status).toBe(404);
		const p2 = await insertProject(db, admin.id, { key: 'GONE', deletedAt: 1 });
		const t2 = await insertTask(db, p2, admin.id, { number: 1, title: 'x' });
		expect((await send({ target: { kind: 'task', id: t2.id } })).status).toBe(404);
		expect(r2.calls).toEqual([]);
	});

	it('an archived project’s task still accepts attachments', async () => {
		const p2 = await insertProject(db, admin.id, { key: 'ARCH', status: 'archived' });
		const t2 = await insertTask(db, p2, admin.id, { number: 1, title: 'x' });
		await uploaded({ target: { kind: 'task', id: t2.id } });
	});

	it('a page accepts attachments too', async () => {
		await uploaded({ target: { kind: 'page', id: pageId } });
	});

	it.each([
		['a bad kind', { target: { kind: 'comment' } }],
		['a malformed id', { target: { id: 'not-a-uuid' } }],
		['no file', { file: null }],
		['two files', { files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')] }]
	])('%s is 400', async (_, init) => {
		const res = await send(init as UploadInit);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: 'bad_request' });
		expect(r2.calls).toEqual([]);
	});

	it('a body that is not multipart is 415', async () => {
		const { event } = fakeEvent({
			url: 'http://localhost/files',
			db,
			user: member,
			form: { targetKind: 'task', targetId: task.id },
			headers: { accept: 'application/json' }
		});
		const res = await call(upload.POST as never, event);
		expect(res.status).toBe(415);
	});

	it('two uploads with the same name get distinct keys; the name never reaches the key', async () => {
		await uploaded({ file: new File(['1'], '../../evil.txt') });
		await uploaded({ file: new File(['2'], '../../evil.txt') });
		const [a, b] = await rows();
		expect(a?.r2Key).not.toBe(b?.r2Key);
		for (const r of [a, b]) {
			expect(r?.r2Key).toMatch(/^att\/[0-9a-f-]{36}$/);
			expect(r?.filename).toBe('evil.txt');
		}
	});

	it('names are cleaned before storage', async () => {
		// An empty name never arrives as a file (the multipart encoder sends filename="", which parses as a plain
		// field) and is covered by the cleanFilename unit table, like quotes and CR/LF.
		const names = ['a‮gnp.exe', `${'n'.repeat(300)}.pdf`, 'CON.txt', 'q"uo\r\nte 🎉.txt', '...'];
		for (const name of names) {
			const res = await send({ file: new File(['x'], name) });
			expect([name, res.status]).toEqual([name, 201]);
		}
		const stored = (await rows()).map((r) => r.filename);
		expect(stored[0]).toBe('agnp.exe');
		expect(Array.from(stored[1] ?? '')).toHaveLength(120);
		expect(stored[2]).toBe('_CON.txt');
		expect(stored[3]).toBe('quo te 🎉.txt');
		expect(stored[4]).toBe('file');
	});

	it('the client type is ignored: evil.html is octet-stream; a fake PNG is octet-stream', async () => {
		await uploaded({
			file: new File(['<script>alert(1)</script>'], 'evil.html', { type: 'text/html' })
		});
		await uploaded({ file: new File(['<svg onload=alert(1)>'], 'x.png', { type: 'image/png' }) });
		await uploaded({ file: new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }) });
		expect((await rows()).map((r) => r.contentType)).toEqual([
			'application/octet-stream',
			'application/octet-stream',
			'application/octet-stream'
		]);
	});

	it('the R2 object carries the stored type and the attachment id', async () => {
		const { id } = await uploaded({ file: new File([PNG], 'pic.png') });
		const [row] = await rows();
		const head = await real.head(row?.r2Key ?? '');
		expect(head?.httpMetadata?.contentType).toBe('image/png');
		expect(head?.customMetadata).toEqual({ attachmentId: id });
	});

	it('a failed R2 put is 503 with no row', async () => {
		r2.fail.put = 1;
		const res = await send();
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ error: 'storage' });
		expect(await rows()).toEqual([]);
	});

	it('a D1 failure after the put deletes the object, answers 503 and leaves no row', async () => {
		await db.run(
			sql.raw(
				`CREATE TRIGGER fail_attachment BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'injected'); END`
			)
		);
		try {
			const res = await send({ file: new File(['secret bytes'], 'Secret plan.txt') });
			expect(res.status).toBe(503);
			expect(await rows()).toEqual([]);
			expect(await objects()).toEqual([]);
			expect(r2.calls.map((c) => c.split(' ')[0])).toEqual(['put', 'delete']);
			expect(logs.some((l) => l[0] === 'attachment_orphan_candidate')).toBe(false);

			// The cleanup delete fails too: the object is an orphan, logged with its key only.
			r2.reset();
			r2.fail.delete = 1;
			const again = await send({ file: new File(['secret bytes'], 'Secret plan.txt') });
			expect(again.status).toBe(503);
			const orphan = logs.find((l) => l[0] === 'attachment_orphan_candidate');
			const key = r2.calls[0]?.split(' ')[1];
			expect(orphan?.[1]).toMatchObject({ key });
			expect(JSON.stringify(orphan)).not.toContain('Secret');
		} finally {
			await db.run(sql.raw('DROP TRIGGER fail_attachment'));
		}
	});

	it('the 21st upload in a window is 429 and stores nothing', async () => {
		for (let i = 0; i < 20; i++) await send({ target: { kind: 'task', id: crypto.randomUUID() } });
		const res = await send();
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
		expect(await res.json()).toMatchObject({ error: 'throttled' });
		expect(r2.calls).toEqual([]);
		expect(await rows()).toEqual([]);
	});

	it('without JavaScript: a 303 back to the page with a flash code', async () => {
		const ok = await send({ json: false, returnTo: taskPath });
		expect(ok.status).toBe(303);
		expect(ok.headers.get('location')).toBe(`${taskPath}?uploaded=1#attachments`);
		const bad = await send({ json: false, returnTo: taskPath, file: new File([], 'e.txt') });
		expect(bad.headers.get('location')).toBe(`${taskPath}?upload_error=empty#attachments`);
	});

	it.each(['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])(
		'returnTo %s is ignored: the redirect goes to the target page',
		async (returnTo) => {
			const res = await send({ json: false, returnTo });
			expect(res.headers.get('location')).toBe(`${taskPath}?uploaded=1#attachments`);
		}
	);
});

describe('download', () => {
	it('a PDF: attachment, nosniff, sandbox CSP, no-store, exact length and bytes', async () => {
		const bytes = new TextEncoder().encode('%PDF-1.7 fictional');
		const { id } = await uploaded({ file: new File([bytes], 'Report.pdf') });
		const res = await get(id);
		expect(res.status).toBe(200);
		expect(Object.fromEntries(res.headers)).toMatchObject({
			'content-type': 'application/pdf',
			'content-disposition': `attachment; filename="Report.pdf"; filename*=UTF-8''Report.pdf`,
			'x-content-type-options': 'nosniff',
			'content-security-policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
			'x-frame-options': 'DENY',
			'cross-origin-resource-policy': 'same-origin',
			'cache-control': 'private, no-store',
			'content-length': String(bytes.length)
		});
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
	});

	it('?inline=1 is inline only for a real image; HTML, SVG and a fake PNG stay attachments', async () => {
		const png = await uploaded({ file: new File([PNG], 'pic.png') });
		const res = await get(png.id, { query: '?inline=1' });
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('content-disposition')).toMatch(/^inline; /);
		expect((await get(png.id)).headers.get('content-disposition')).toMatch(/^attachment; /);
		for (const file of [
			new File(['<script>alert(1)</script>'], 'evil.html'),
			new File(['<svg onload=alert(1)>'], 'x.svg'),
			new File(['<svg onload=alert(1)>'], 'fake.png'),
			new File(['%PDF'], 'a.pdf')
		]) {
			const { id } = await uploaded({ file });
			const r = await get(id, { query: '?inline=1' });
			expect(r.headers.get('content-disposition')).toMatch(/^attachment; /);
			expect(r.headers.get('content-type')).not.toMatch(/html|svg/);
		}
	});

	it('a non-ASCII name gets filename* and an ASCII fallback; CR/LF cannot inject a header', async () => {
		const { id } = await uploaded({ file: new File(['x'], 'Übersicht\r\nSet-Cookie: a=b.txt') });
		const header = (await get(id)).headers.get('content-disposition') ?? '';
		const [row] = await rows();
		expect(header).not.toMatch(/[\r\n]/);
		expect(header).toMatch(
			/^attachment; filename="_bersicht[^"]*Set-Cookie a=b\.txt"; filename\*=UTF-8''/
		);
		expect(decodeURIComponent(header.split("UTF-8''")[1] ?? '')).toBe(row?.filename);
		expect((await get(id)).headers.get('set-cookie')).toBeNull();
	});

	it('a stored type outside the allowlist is served as octet-stream', async () => {
		const { id } = await uploaded();
		await db.run(sql`update attachments set content_type = 'text/html' where id = ${id}`);
		expect((await get(id)).headers.get('content-type')).toBe('application/octet-stream');
	});

	it('If-None-Match with the ETag is 304 with the same headers and no body', async () => {
		const { id } = await uploaded();
		const etag = (await get(id)).headers.get('etag') ?? '';
		expect(etag).not.toBe('');
		const res = await get(id, { headers: { 'if-none-match': etag } });
		expect(res.status).toBe(304);
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(await res.text()).toBe('');
		// A signed-out conditional request is still refused.
		expect((await get(id, { user: null, headers: { 'if-none-match': etag } })).status).toBe(401);
	});

	it('tombstoned, orphaned (task or page deleted), malformed, unknown and object-missing ids: the same 404', async () => {
		const a = await uploaded();
		const b = await uploaded();
		const c = await uploaded({ target: { kind: 'page', id: pageId } });
		const d = await uploaded();
		await del(a.id);
		const p2 = await insertProject(db, admin.id, { key: 'TWO' });
		const t2 = await insertTask(db, p2, admin.id, { number: 1, title: 'x' });
		const e = await uploaded({ target: { kind: 'task', id: t2.id } });
		await db.run(sql`update tasks set deleted_at = 1 where id = ${task.id}`);
		await db.run(sql`update pages set deleted_at = 1 where id = ${pageId}`);
		await db.run(sql`update projects set deleted_at = 1 where id = ${p2.id}`);
		void b;
		void d;
		const answers = [];
		for (const id of [a.id, b.id, c.id, e.id, 'nope', '../../etc/passwd', crypto.randomUUID()]) {
			const res = await get(id);
			answers.push([res.status, await res.text()]);
		}
		// An object that vanished from R2 behind a live row and parent.
		await db.run(sql`update tasks set deleted_at = null where id = ${task.id}`);
		const [row] = (await rows()).filter((r) => r.id === d.id);
		await real.delete(row?.r2Key ?? '');
		const missing = await get(d.id);
		answers.push([missing.status, await missing.text()]);
		expect(new Set(answers.map((x) => JSON.stringify(x)))).toEqual(
			new Set([JSON.stringify([404, JSON.stringify({ message: 'File not found.' })])])
		);
		expect(logs.find((l) => l[0] === 'attachment_object_missing')?.[1]).toEqual({ id: d.id });
	});
});

describe('delete', () => {
	it('by the uploader: tombstone first, then the R2 object', async () => {
		const { id } = await uploaded();
		const [row] = await rows();
		let tombstonedFirst = false;
		r2.hooks.onDelete = async () => {
			const [now] = await rows();
			tombstonedFirst = now?.deletedAt !== null;
		};
		const res = await del(id, member);
		expect(res.status).toBe(200);
		expect(tombstonedFirst).toBe(true);
		expect(r2.calls.at(-1)).toBe(`delete ${row?.r2Key}`);
		expect(await objects()).toEqual([]);
		expect((await get(id)).status).toBe(404);
	});

	it('by an admin succeeds; by another member is 403 and nothing changes', async () => {
		const { id } = await uploaded();
		r2.calls.length = 0;
		expect((await del(id, other)).status).toBe(403);
		expect(r2.calls).toEqual([]);
		expect((await rows())[0]?.deletedAt).toBeNull();
		expect((await del(id, admin)).status).toBe(200);
		expect((await rows())[0]?.deletedAt).not.toBeNull();
	});

	it('a repeat delete is idempotent (and retries the R2 delete); others get 404', async () => {
		const { id } = await uploaded();
		expect((await del(id)).status).toBe(200);
		const at = (await rows())[0]?.deletedAt;
		expect((await del(id)).status).toBe(200);
		expect((await rows())[0]?.deletedAt).toBe(at);
		expect((await del(id, other)).status).toBe(404);
	});

	it('an R2 delete failure still answers success and is logged with the key only', async () => {
		const { id } = await uploaded({ file: new File(['x'], 'Private name.txt') });
		r2.fail.delete = 1;
		expect((await del(id)).status).toBe(200);
		const line = logs.find((l) => l[0] === 'attachment_r2_delete_failed');
		expect(line?.[1]).toMatchObject({ key: expect.stringMatching(/^att\//) });
		expect(JSON.stringify(line)).not.toContain('Private');
		expect((await get(id)).status).toBe(404);
	});

	it('unknown and malformed ids are 404; a missing confirm is 400', async () => {
		expect((await del(crypto.randomUUID())).status).toBe(404);
		expect((await del('x')).status).toBe(404);
		const { id } = await uploaded();
		expect((await del(id, member, {})).status).toBe(400);
		expect((await rows())[0]?.deletedAt).toBeNull();
	});

	it('without JavaScript: a 303 back with a flash code', async () => {
		const { id } = await uploaded();
		const denied = await del(id, other, { confirm: 'yes', returnTo: taskPath }, false);
		expect(denied.status).toBe(303);
		expect(denied.headers.get('location')).toBe(`${taskPath}?delete_error=forbidden#attachments`);
		const ok = await del(id, member, { confirm: 'yes', returnTo: '//evil.example' }, false);
		expect(ok.headers.get('location')).toBe(`${taskPath}?deleted=1#attachments`);
	});

	it('a deactivated uploader’s file stays downloadable and an admin can delete it', async () => {
		const { id } = await uploaded();
		await db.run(sql`update users set status = 'disabled' where id = ${member.id}`);
		expect((await get(id, { user: other })).status).toBe(200);
		expect((await del(id, admin)).status).toBe(200);
	});
});

describe('panel data', () => {
	it('lists live files with uploader and permissions, never an R2 key', async () => {
		await uploaded({ file: new File([PNG], 'pic.png') });
		const gone = await uploaded();
		await uploaded({ user: other });
		await del(gone.id);
		const panel = await attachmentPanel(
			db,
			member,
			'task',
			task.id,
			new URL(`http://localhost${taskPath}?uploaded=1`)
		);
		expect(
			panel.items.map((i) => [i.filename, i.extension, i.image, i.uploaderName, i.canDelete])
		).toEqual([
			['pic.png', 'png', true, 'Max Member', true],
			['a.txt', 'txt', false, 'Olu Other', false]
		]);
		expect(panel).toMatchObject({ returnTo: taskPath, max: 20, flash: { tone: 'success' } });
		expect(JSON.stringify(panel)).not.toContain('att/');
		const asAdmin = await attachmentPanel(
			db,
			admin,
			'task',
			task.id,
			new URL(`http://localhost${taskPath}?upload_error=<b>`)
		);
		expect(asAdmin.items.every((i) => i.canDelete)).toBe(true);
		expect(asAdmin.flash).toBeNull();
	});

	it('the page view loads its attachments', async () => {
		await uploaded({ target: { kind: 'page', id: pageId } });
		const { event } = fakeEvent({
			url: `http://localhost/kb/${pageId}`,
			db,
			user: member,
			params: { id: pageId }
		});
		const data = (await kbView.load(event as never)) as { attachments: { items: unknown[] } };
		expect(data.attachments.items).toHaveLength(1);
		expect(JSON.stringify(data)).not.toContain('att/');
	});
});

describe('logs', () => {
	it('never carry a file name or content', async () => {
		r2.fail.put = 1;
		await send({ file: new File(['TOPSECRET'], 'Quarterly salaries.xlsx') });
		const { id } = await uploaded({ file: new File(['TOPSECRET'], 'Quarterly salaries.xlsx') });
		r2.fail.delete = 1;
		await del(id);
		const text = JSON.stringify(logs);
		expect(text).not.toContain('Quarterly');
		expect(text).not.toContain('TOPSECRET');
		expect(text).not.toContain(member.id);
	});
});

describe('retention purge (SECURITY_REPORT L5)', () => {
	const DAY = 24 * 60 * 60 * 1000;
	const adminEvent = (user: SessionUser, form?: Record<string, string>) =>
		fakeEvent({
			url: 'http://localhost/admin/attachments',
			db,
			user,
			form,
			routeId: '/(app)/admin/attachments'
		}).event;
	const purge = (user: SessionUser, form: Record<string, string> = { confirm: 'yes' }) =>
		(retention.actions.purge as (e: never) => Promise<unknown>)(adminEvent(user, form) as never);

	it('purges files of items deleted 30+ days ago, keeps the rest, and is admin only', async () => {
		const old = await uploaded();
		const p2 = await insertProject(db, admin.id, { key: 'OLDP' });
		const t2 = await insertTask(db, p2, admin.id, { number: 1, title: 'x' });
		const inOldProject = await uploaded({ target: { kind: 'task', id: t2.id } });
		const recentPage = await uploaded({ target: { kind: 'page', id: pageId } });
		const p3 = await insertProject(db, admin.id, { key: 'LIVE' });
		const t3 = await insertTask(db, p3, admin.id, { number: 1, title: 'x' });
		const live = await uploaded({ target: { kind: 'task', id: t3.id } });
		const now = Date.now();
		await db.run(sql`update tasks set deleted_at = ${now - 31 * DAY} where id = ${task.id}`);
		await db.run(sql`update projects set deleted_at = ${now - 30 * DAY} where id = ${p2.id}`);
		await db.run(sql`update pages set deleted_at = ${now - 10 * DAY} where id = ${pageId}`);
		const keyOf = async (id: string) => (await rows()).find((r) => r.id === id)?.r2Key;
		const oldKey = await keyOf(old.id);

		// A member gets 403 for the page and the action; nothing changes.
		await expect(retention.load(adminEvent(member) as never)).rejects.toMatchObject({
			status: 403
		});
		await expect(purge(member)).rejects.toMatchObject({ status: 403 });
		expect((await retention.load(adminEvent(admin) as never)) as unknown).toMatchObject({
			purgeable: 2,
			days: 30
		});
		// Without the confirmation box: refused.
		expect(await purge(admin, {})).toMatchObject({ status: 400 });

		expect(await purge(admin)).toEqual({ purged: { purged: 2, more: false, failedDeletes: 0 } });
		const after = await rows();
		const tomb = (id: string) => after.find((r) => r.id === id)?.deletedAt !== null;
		expect([old, inOldProject].every((a) => tomb(a.id))).toBe(true);
		expect([recentPage, live].some((a) => tomb(a.id))).toBe(false);
		expect(await objects()).not.toContain(oldKey);
		expect(await objects()).toHaveLength(2);
		expect(await purge(admin)).toEqual({ purged: { purged: 0, more: false, failedDeletes: 0 } });
	});

	it('a restored item’s files are kept; an R2 failure still tombstones and reports it', async () => {
		const a = await uploaded();
		const b = await uploaded({ target: { kind: 'page', id: pageId } });
		const long = Date.now() - 40 * DAY;
		await db.run(sql`update tasks set deleted_at = ${long} where id = ${task.id}`);
		await db.run(sql`update tasks set deleted_at = null where id = ${task.id}`);
		await db.run(sql`update pages set deleted_at = ${long} where id = ${pageId}`);
		r2.fail.delete = 1;
		expect(await purge(admin)).toEqual({ purged: { purged: 1, more: false, failedDeletes: 1 } });
		const after = await rows();
		expect(after.find((r) => r.id === a.id)?.deletedAt).toBeNull();
		expect(after.find((r) => r.id === b.id)?.deletedAt).not.toBeNull();
		expect(logs.find((l) => l[0] === 'attachment_purge_r2_delete_failed')?.[1]).toMatchObject({
			count: 1
		});
	});
});
