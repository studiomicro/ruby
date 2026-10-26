import { isHttpError } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { sessionCookieName } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { spyR2 } from '../helpers/fake-r2';
import { insertProject, insertTask } from '../helpers/seed-kb';
import { insertSession, insertUser } from '../helpers/users';

/**
 * RB-04 red-team probes through the real route handlers and hooks (docs/features/rb-04-attachments/SECURITY_REPORT.md),
 * against local D1 and the local R2 bucket from openLocalD1 (`env.FILES`, wrapped by spyR2). Nothing remote.
 */

const binding: Record<string, unknown> = { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' };
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const { handle } = await import('../../src/hooks.server');
const upload = await import('../../src/routes/(app)/files/+server');
const download = await import('../../src/routes/(app)/files/[id]/+server');
const remove = await import('../../src/routes/(app)/files/[id]/delete/+server');

let db: Db;
let dispose: () => Promise<void>;
let real: R2Bucket;
let r2: ReturnType<typeof spyR2>;
let admin: SessionUser;
let member: SessionUser;
let other: SessionUser;
let task: { id: string };
let projectId: string;
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
	for (const o of (await real.list({ prefix: 'att/' })).objects) await real.delete(o.key);
	admin = await insertUser(db, { role: 'admin', name: 'Ada Admin' });
	member = await insertUser(db, { role: 'member', name: 'Max Member' });
	other = await insertUser(db, { role: 'member', name: 'Olu Other' });
	const project = await insertProject(db, admin.id, { key: 'OPS' });
	projectId = project.id;
	task = await insertTask(db, project, admin.id, { number: 1, title: 'Fictional task' });
});
afterEach(() => vi.restoreAllMocks());

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bytes = (...parts: (number[] | string)[]) =>
	new Uint8Array(
		parts.flatMap((p) => (typeof p === 'string' ? [...new TextEncoder().encode(p)] : p))
	);

async function call(fn: unknown, event: unknown): Promise<Response> {
	try {
		return (await (fn as (e: never) => Promise<Response>)(event as never)) as Response;
	} catch (e) {
		if (isHttpError(e)) return Response.json({ message: e.body.message }, { status: e.status });
		throw e;
	}
}

function formOf(
	fields: Record<string, string>,
	files: { name: string; data: BlobPart; type?: string }[] = []
) {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.append(k, v);
	for (const f of files) form.append('file', new File([f.data], f.name, { type: f.type ?? '' }));
	return form;
}

function uploadEvent(
	body: BodyInit,
	opts: { user?: SessionUser | null; headers?: Record<string, string>; query?: string } = {}
) {
	const { event } = fakeEvent({
		url: `http://localhost/files${opts.query ?? ''}`,
		method: 'POST',
		db,
		user: opts.user === undefined ? member : (opts.user ?? undefined),
		routeId: '/(app)/files'
	});
	const headers = { origin: 'http://localhost', accept: 'application/json', ...opts.headers };
	Object.assign(event, {
		request: new Request(`http://localhost/files${opts.query ?? ''}`, {
			method: 'POST',
			body,
			headers,
			duplex: 'half'
		} as RequestInit)
	});
	return event;
}

const send = (
	files: { name: string; data: BlobPart; type?: string }[] = [{ name: 'a.txt', data: 'hello' }],
	fields: Record<string, string> = { targetKind: 'task', targetId: '' },
	opts: Parameters<typeof uploadEvent>[1] = {}
) =>
	call(
		upload.POST,
		uploadEvent(formOf({ ...fields, targetId: fields.targetId || task.id }, files), opts)
	);

async function uploaded(name: string, data: BlobPart, user = member) {
	const res = await send([{ name, data }], undefined, { user });
	expect(res.status, name).toBe(201);
	return (await res.json()) as { id: string; contentType: string; filename: string };
}

const get = (id: string, query = '', headers: Record<string, string> = {}) =>
	call(
		download.GET,
		fakeEvent({
			url: `http://localhost/files/${id}${query}`,
			db,
			user: member,
			params: { id },
			headers,
			routeId: '/(app)/files/[id]'
		}).event
	);

const del = (id: string, user: SessionUser) =>
	call(
		remove.POST,
		fakeEvent({
			url: `http://localhost/files/${id}/delete`,
			db,
			user,
			params: { id },
			form: { confirm: 'yes' },
			headers: { accept: 'application/json' },
			routeId: '/(app)/files/[id]/delete'
		}).event
	);

async function rowCount() {
	return (
		(await db.$client.prepare('SELECT count(*) AS n FROM attachments').first<{ n: number }>())?.n ??
		0
	);
}
const objectCount = async () => (await real.list({ prefix: 'att/' })).objects.length;

describe('stored XSS through uploads: what the browser is told', () => {
	const SAFE = {
		'x-content-type-options': 'nosniff',
		'content-security-policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
		'x-frame-options': 'DENY',
		'cross-origin-resource-policy': 'same-origin',
		'cache-control': 'private, no-store'
	};

	it('HTML, SVG, XML, JS and XHTML bodies (client type text/html) are octet-stream attachments, even with inline=1', async () => {
		const payloads: [string, string][] = [
			['evil.html', '<script>alert(document.cookie)</script>'],
			['evil.HTM', '<script>alert(1)</script>'],
			['evil.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
			[
				'evil.xml',
				'<?xml version="1.0"?><x:script xmlns:x="http://www.w3.org/1999/xhtml">alert(1)</x:script>'
			],
			['evil.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>'],
			['evil.js', 'alert(1)'],
			['evil.png.html', '<script>alert(1)</script>'],
			['evil.html\u0000.png', '<script>alert(1)</script>'],
			['evil.html.', '<script>alert(1)</script>']
		];
		for (const [name, body] of payloads) {
			const res = await send([{ name, data: body, type: 'text/html' }]);
			expect(res.status, name).toBe(201);
			const { id, contentType } = (await res.json()) as { id: string; contentType: string };
			expect(contentType, name).toBe('application/octet-stream');
			const dl = await get(id, '?inline=1');
			expect(dl.status).toBe(200);
			expect(dl.headers.get('content-type')).toBe('application/octet-stream');
			expect(dl.headers.get('content-disposition')).toMatch(/^attachment; /);
			for (const [h, v] of Object.entries(SAFE)) expect(dl.headers.get(h), `${name} ${h}`).toBe(v);
		}
	});

	it('a PNG header with an HTML body is image/png inline (nosniff + sandbox: rendered as an image, no script)', async () => {
		const { id, contentType } = await uploaded(
			'poly.png',
			bytes(PNG, '<html><body><script>alert(1)</script></body></html>')
		);
		expect(contentType).toBe('image/png');
		const dl = await get(id, '?inline=1');
		expect(dl.headers.get('content-type')).toBe('image/png');
		expect(dl.headers.get('content-disposition')).toMatch(/^inline; /);
		for (const [h, v] of Object.entries(SAFE)) expect(dl.headers.get(h)).toBe(v);
	});

	it('PDF, text, CSV, JSON and Markdown (all script-capable in some viewer) are never inline', async () => {
		for (const [name, body] of [
			['x.pdf', '%PDF-1.4\n1 0 obj<</OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj'],
			['x.txt', '<script>alert(1)</script>'],
			['x.csv', '=HYPERLINK("https://evil.example","x")'],
			['x.json', '{"a":"<script>alert(1)</script>"}'],
			['x.md', '<script>alert(1)</script>']
		]) {
			const { id } = await uploaded(name as string, body as string);
			const dl = await get(id, '?inline=1');
			expect(dl.headers.get('content-disposition'), name).toMatch(/^attachment; /);
			expect(dl.headers.get('content-security-policy')).toBe(
				"sandbox; default-src 'none'; frame-ancestors 'none'"
			);
		}
	});

	it('LOW L4 (fixed): no page may frame a download (frame-ancestors none, X-Frame-Options DENY)', async () => {
		const { id } = await uploaded('poly.png', bytes(PNG, 'x'));
		for (const query of ['?inline=1', '']) {
			const dl = await get(id, query);
			expect(dl.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
			expect(dl.headers.get('x-frame-options')).toBe('DENY');
		}
	});
});

describe('range, ETag and 304 never leak a deleted file', () => {
	it('a Range request gets the whole body as 200 (no 206, no Content-Range)', async () => {
		const { id } = await uploaded('a.txt', '0123456789');
		const dl = await get(id, '', { range: 'bytes=2-4' });
		expect(dl.status).toBe(200);
		expect(dl.headers.get('content-range')).toBeNull();
		expect(await dl.text()).toBe('0123456789');
	});

	it('If-None-Match with the old ETag after delete, or after the parent task is deleted, is 404 (not 304)', async () => {
		const a = await uploaded('a.txt', 'one');
		const b = await uploaded('b.txt', 'two');
		const etagA = (await get(a.id)).headers.get('etag') as string;
		const etagB = (await get(b.id)).headers.get('etag') as string;
		expect((await get(a.id, '', { 'if-none-match': etagA })).status).toBe(304);

		expect((await del(a.id, member)).status).toBe(200);
		expect((await get(a.id, '', { 'if-none-match': etagA })).status).toBe(404);
		expect((await get(a.id, '', { 'if-none-match': '*' })).status).toBe(404);

		await db.run(sql`UPDATE tasks SET deleted_at = ${Date.now()} WHERE id = ${task.id}`);
		expect((await get(b.id, '', { 'if-none-match': etagB })).status).toBe(404);
		expect((await get(b.id)).status).toBe(404);
	});

	it('a file on a task whose project is soft-deleted is the same 404', async () => {
		const { id } = await uploaded('a.txt', 'x');
		await db.run(sql`UPDATE projects SET deleted_at = ${Date.now()} WHERE id = ${projectId}`);
		const res = await get(id);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ message: 'File not found.' });
	});
});

describe('authorization through the hook (session cookie, not a stubbed locals.user)', () => {
	const viaHook = async (init: {
		url: string;
		method: string;
		routeId: string;
		token?: string;
		origin?: string;
		body?: BodyInit;
		contentType?: string;
	}) => {
		const resolve = vi.fn(async () => new Response('ran'));
		const { event } = fakeEvent({
			url: init.url,
			method: init.method,
			db,
			routeId: init.routeId,
			cookies: init.token ? { [sessionCookieName(false)]: init.token } : {}
		});
		const headers: Record<string, string> = {};
		if (init.origin) headers.origin = init.origin;
		if (init.contentType) headers['content-type'] = init.contentType;
		Object.assign(event, {
			request: new Request(init.url, { method: init.method, body: init.body, headers })
		});
		const response = await handle({ event, resolve } as never);
		return { response, resolve, event };
	};

	it('signed out: upload 401, delete 401, download redirected to sign-in; no handler runs', async () => {
		const { id } = await uploaded('a.txt', 'x');
		r2.calls.length = 0;
		const form = formOf({ targetKind: 'task', targetId: task.id }, [{ name: 'a.txt', data: 'x' }]);
		const up = await viaHook({
			url: 'http://localhost/files',
			method: 'POST',
			routeId: '/(app)/files',
			origin: 'http://localhost',
			body: form
		});
		expect(up.response.status).toBe(401);
		const rm = await viaHook({
			url: `http://localhost/files/${id}/delete`,
			method: 'POST',
			routeId: '/(app)/files/[id]/delete',
			origin: 'http://localhost',
			body: new URLSearchParams({ confirm: 'yes' })
		});
		expect(rm.response.status).toBe(401);
		const dl = await viaHook({
			url: `http://localhost/files/${id}`,
			method: 'GET',
			routeId: '/(app)/files/[id]'
		});
		expect(dl.response.status).toBe(303);
		expect(dl.response.headers.get('location')).toMatch(/^\/login\?next=/);
		for (const r of [up, rm, dl]) expect(r.resolve).not.toHaveBeenCalled();
		expect(r2.calls).toEqual([]);
	});

	it('a disabled user’s live session cannot upload, download or delete', async () => {
		const { id } = await uploaded('a.txt', 'x');
		const disabled = await insertUser(db, { status: 'disabled' });
		const token = await insertSession(db, disabled.id);
		for (const [url, method, routeId] of [
			['http://localhost/files', 'POST', '/(app)/files'],
			[`http://localhost/files/${id}`, 'GET', '/(app)/files/[id]'],
			[`http://localhost/files/${id}/delete`, 'POST', '/(app)/files/[id]/delete']
		] as const) {
			const r = await viaHook({
				url,
				method,
				routeId,
				token,
				origin: 'http://localhost',
				...(method === 'POST' ? { body: new URLSearchParams({ confirm: 'yes' }) } : {})
			});
			expect(r.event.locals.user).toBeNull();
			expect(r.resolve).not.toHaveBeenCalled();
		}
	});

	it('CSRF: cross-site and null-Origin upload and delete posts are 403 before routing; nothing stored', async () => {
		const { id } = await uploaded('a.txt', 'x');
		const token = await insertSession(db, member.id);
		for (const origin of ['https://evil.example', 'null', undefined]) {
			const up = await viaHook({
				url: 'http://localhost/files',
				method: 'POST',
				routeId: '/(app)/files',
				token,
				origin,
				body: formOf({ targetKind: 'task', targetId: task.id }, [{ name: 'b.txt', data: 'y' }])
			});
			expect(up.response.status).toBe(403);
			const rm = await viaHook({
				url: `http://localhost/files/${id}/delete`,
				method: 'POST',
				routeId: '/(app)/files/[id]/delete',
				token,
				origin,
				body: new URLSearchParams({ confirm: 'yes' })
			});
			expect(rm.response.status).toBe(403);
			expect(up.resolve).not.toHaveBeenCalled();
			expect(rm.resolve).not.toHaveBeenCalled();
		}
		expect(await rowCount()).toBe(1);
		expect((await get(id)).status).toBe(200);
	});
});

describe('IDOR and target confusion', () => {
	it('another member cannot delete; an admin can; the uploader’s id in the form changes nothing', async () => {
		const { id } = await uploaded('a.txt', 'x');
		expect((await del(id, other)).status).toBe(403);
		expect((await get(id)).status).toBe(200);
		expect((await del(id, admin)).status).toBe(200);
		expect((await get(id)).status).toBe(404);
		expect(await objectCount()).toBe(0);
	});

	it('a task id sent as a page, an unknown kind, a non-uuid or an upper-case uuid of nothing: no row, no object', async () => {
		for (const fields of [
			{ targetKind: 'page', targetId: task.id },
			{ targetKind: 'comment', targetId: task.id },
			{ targetKind: 'task', targetId: `${task.id}' OR 1=1 --` },
			{ targetKind: 'task', targetId: '../../att/x' },
			{ targetKind: 'task', targetId: crypto.randomUUID().toUpperCase() }
		]) {
			const res = await send(undefined, fields);
			expect([400, 404], JSON.stringify(fields)).toContain(res.status);
		}
		expect(await rowCount()).toBe(0);
		expect(await objectCount()).toBe(0);
	});

	it('the R2 key is server-made whatever the name; customMetadata holds only the attachment id', async () => {
		const { id } = await uploaded('../../att/../etc/passwd', 'x');
		const row = await db.$client
			.prepare('SELECT r2_key AS k, filename AS f FROM attachments WHERE id = ?1')
			.bind(id)
			.first<{ k: string; f: string }>();
		expect(row?.k).toMatch(/^att\/[0-9a-f-]{36}$/);
		expect(row?.f).toBe('att..etcpasswd');
		const head = await real.head(row?.k as string);
		expect(head?.customMetadata).toEqual({ attachmentId: id });
	});

	it('a delete on a file whose task was deleted is 404 (the object stays, unreachable — tracked as L5)', async () => {
		const { id } = await uploaded('a.txt', 'x');
		await db.run(sql`UPDATE tasks SET deleted_at = ${Date.now()} WHERE id = ${task.id}`);
		expect((await del(id, member)).status).toBe(404);
		expect(await objectCount()).toBe(1);
	});
});

describe('multipart edge cases and size enforcement', () => {
	it('two files, no file, a file field sent as text: 400 and nothing stored', async () => {
		expect(
			(
				await send([
					{ name: 'a.txt', data: 'a' },
					{ name: 'b.txt', data: 'b' }
				])
			).status
		).toBe(400);
		expect((await send([])).status).toBe(400);
		const f = formOf({ targetKind: 'task', targetId: task.id, file: 'not a file' });
		expect((await call(upload.POST, uploadEvent(f))).status).toBe(400);
		expect(await rowCount()).toBe(0);
		expect(r2.calls.filter((c) => c.startsWith('put'))).toEqual([]);
	});

	it('a huge returnTo and a huge extra text field are bounded: the redirect falls back, nothing breaks', async () => {
		const res = await send(
			[{ name: 'a.txt', data: 'x' }],
			{
				targetKind: 'task',
				targetId: task.id,
				returnTo: `/${'a'.repeat(500_000)}`,
				junk: 'j'.repeat(500_000)
			},
			{ headers: { accept: 'text/html' } }
		);
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('/projects/OPS/tasks/1?uploaded=1#attachments');
	});

	it('a chunked body (no Content-Length) past the bound is 413 with no object and no row', async () => {
		const boundary = 'rbBOUNDARY';
		const enc = new TextEncoder();
		const fieldPart = (n: string, v: string) =>
			enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`);
		const chunks = [
			fieldPart('targetKind', 'task'),
			fieldPart('targetId', task.id),
			enc.encode(
				`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n\r\n`
			)
		];
		let sent = 0;
		const total = 28 * 1024 * 1024;
		const body = new ReadableStream<Uint8Array>({
			pull(c) {
				const next = chunks.shift();
				if (next) return c.enqueue(next);
				if (sent >= total) {
					c.enqueue(enc.encode(`\r\n--${boundary}--\r\n`));
					return c.close();
				}
				sent += 1024 * 1024;
				c.enqueue(new Uint8Array(1024 * 1024));
			}
		});
		const res = await call(
			upload.POST,
			uploadEvent(body, {
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			})
		);
		expect(res.status).toBe(413);
		expect(sent).toBeLessThan(total);
		expect(await rowCount()).toBe(0);
		expect(await objectCount()).toBe(0);
	});

	it('cap under concurrency: 18 live + 6 parallel uploads = exactly 20 rows and exactly 20 objects', async () => {
		for (let i = 0; i < 18; i++) await uploaded(`seed${i}.txt`, 'x', i % 2 ? member : other);
		const results = await Promise.all(
			Array.from({ length: 6 }, (_, i) =>
				send([{ name: `race${i}.txt`, data: 'r' }], undefined, { user: i % 2 ? admin : other })
			)
		);
		const codes = results.map((r) => r.status).sort();
		expect(codes.filter((c) => c === 201)).toHaveLength(2);
		expect(codes.filter((c) => c === 409)).toHaveLength(4);
		expect(await rowCount()).toBe(20);
		expect(await objectCount()).toBe(20);
	});
});

describe('throttle', () => {
	it('failed attempts count too: 20 malformed posts, then a valid one is 429 and nothing is stored', async () => {
		for (let i = 0; i < 20; i++)
			await call(upload.POST, uploadEvent('x', { headers: { 'content-type': 'text/plain' } }));
		const res = await send();
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
		expect(await rowCount()).toBe(0);
		expect(r2.calls).toEqual([]);
	});
});

describe('logs', () => {
	it('no path of upload, download or delete logs a file name, content or user id', async () => {
		const name = 'Quarterly-SECRET-merger-plan.txt';
		await db.run(
			sql.raw(
				`CREATE TRIGGER fail_attachment BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'injected'); END`
			)
		);
		try {
			r2.fail.delete = 1;
			expect((await send([{ name, data: 'TOPSECRETBYTES' }])).status).toBe(503);
		} finally {
			await db.run(sql.raw('DROP TRIGGER fail_attachment'));
		}
		r2.fail.put = 1;
		expect((await send([{ name, data: 'TOPSECRETBYTES' }])).status).toBe(503);
		const { id } = await uploaded(name, 'TOPSECRETBYTES');
		r2.fail.delete = 1;
		expect((await del(id, member)).status).toBe(200);
		const text = JSON.stringify(logs);
		expect(logs.some((l) => l[0] === 'attachment_orphan_candidate')).toBe(true);
		for (const secret of ['SECRET', 'merger', 'TOPSECRETBYTES', member.id, member.email])
			expect(text).not.toContain(secret);
	});
});

describe('session revocation during a long upload', () => {
	it('LOW L3 (fixed): a user disabled while their body is still streaming gets nothing stored', async () => {
		const form = formOf({ targetKind: 'task', targetId: task.id }, [
			{ name: 'slow.txt', data: 'slow upload' }
		]);
		const encoded = new Response(form);
		const type = encoded.headers.get('content-type') as string;
		const all = new Uint8Array(await encoded.arrayBuffer());
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		let step = 0;
		const body = new ReadableStream<Uint8Array>({
			async pull(c) {
				if (step === 0) {
					step = 1;
					return c.enqueue(all.subarray(0, 40));
				}
				await gate;
				c.enqueue(all.subarray(40));
				c.close();
			}
		});
		const pending = call(upload.POST, uploadEvent(body, { headers: { 'content-type': type } }));
		await new Promise((r) => setTimeout(r, 50));
		await db.run(sql`UPDATE users SET status = 'disabled' WHERE id = ${member.id}`);
		await db.run(sql`DELETE FROM sessions WHERE user_id = ${member.id}`);
		release();
		const res = await pending;
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ error: 'signed_out' });
		expect(await rowCount()).toBe(0);
		// The object written before the guarded insert refused was deleted again.
		expect(r2.calls.filter((c) => c.startsWith('delete'))).toHaveLength(1);
		expect((await real.list({ prefix: 'att/' })).objects).toEqual([]);
	});
});
