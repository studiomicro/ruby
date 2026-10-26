import { describe, expect, it } from 'vitest';
import {
	indexOfBytes,
	MultipartReader,
	multipartBoundary,
	parseDispositionHeader,
	type PartHeader
} from './multipart';
import { PART_BYTES, R2Writer } from './r2-writer';
import { classify, OCTET_STREAM } from './content-type';
import { contentDisposition } from './disposition';
import { cleanFilename } from './filename';
import { canDeleteAttachment } from './permissions';
import { ERROR_STATUS, returnPath, withFlash } from './respond';
import {
	ATTACHMENT_ERROR_MESSAGES,
	ATTACHMENT_ERRORS,
	ATTACHMENT_LIMITS,
	attachmentError,
	humanSize
} from '#lib/shared/attachments';

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new TextEncoder().encode(s);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);

describe('limits', () => {
	it('match the owner decisions', () => {
		expect(ATTACHMENT_LIMITS).toEqual({
			maxBytes: 26_214_400,
			maxPerTarget: 20,
			maxFilenameChars: 120,
			bodyOverheadBytes: 1_048_576
		});
	});
	it('every error code has a status and a message', () => {
		for (const code of ATTACHMENT_ERRORS) {
			expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
			expect(ATTACHMENT_ERROR_MESSAGES[code]).toBeTruthy();
		}
		expect(ERROR_STATUS).toMatchObject({
			too_large: 413,
			empty: 422,
			limit: 409,
			target_gone: 404,
			bad_request: 400,
			throttled: 429,
			storage: 503
		});
		expect(attachmentError('limit')).toBe('limit');
		expect(attachmentError('<script>')).toBeNull();
		expect(attachmentError('__proto__')).toBeNull();
		expect(attachmentError(null)).toBeNull();
	});
	it.each([
		[0, '0 B'],
		[1023, '1023 B'],
		[1024, '1 KB'],
		[1536, '1.5 KB'],
		[26_214_400, '25 MB']
	])('humanSize(%d) = %s', (n, s) => expect(humanSize(n)).toBe(s));
});

describe('cleanFilename', () => {
	it.each([
		['report.pdf', 'report.pdf'],
		['../../etc/passwd', 'etcpasswd'],
		['..\\..\\boot.ini', 'boot.ini'],
		['a‮gnp.exe', 'agnp.exe'],
		['zero​width﻿.txt', 'zerowidth.txt'],
		['iso⁦late⁩.txt', 'isolate.txt'],
		['CON.txt', '_CON.txt'],
		['nul', '_nul'],
		['lpt1.log', '_lpt1.log'],
		['console.txt', 'console.txt'],
		['say "hi".txt', 'say hi.txt'],
		['line\r\nbreak.txt', 'line break.txt'],
		['tab\there.txt', 'tab here.txt'],
		['  spaced   out  .md', 'spaced out .md'],
		['...hidden...', 'hidden'],
		['', 'file'],
		['   ', 'file'],
		['///', 'file'],
		['\u0000\u0007', 'file'],
		['a:b*c?d<e>f|g.txt', 'abcdefg.txt'],
		['emoji 🎉.png', 'emoji 🎉.png'],
		['é.txt', 'é.txt'],
		['lone\uD800surrogate.txt', 'lonesurrogate.txt']
	])('%j → %j', (raw, clean) => expect(cleanFilename(raw)).toBe(clean));

	it('cuts a 300-character name to 120 keeping the extension', () => {
		const name = cleanFilename(`${'a'.repeat(300)}.docx`);
		expect(Array.from(name)).toHaveLength(120);
		expect(name.endsWith('.docx')).toBe(true);
	});
	it('counts code points, not UTF-16 units', () => {
		const name = cleanFilename(`${'🎉'.repeat(200)}.png`);
		expect(Array.from(name).length).toBeLessThanOrEqual(120);
		expect(name.endsWith('.png')).toBe(true);
	});
	it('drops an over-long extension instead of keeping it', () => {
		const name = cleanFilename(`${'a'.repeat(130)}.${'x'.repeat(40)}`);
		expect(Array.from(name).length).toBeLessThanOrEqual(120);
	});
	it('a huge input costs nothing', () => {
		expect(Array.from(cleanFilename('a'.repeat(5_000_000))).length).toBe(120);
	});
	it('never leaves a path separator, control, quote or bidi character', () => {
		const nasty = '/\\:*?"<>|\u0000\u001f\u007f\u0085‎‪‮⁦⁩ ';
		expect(cleanFilename(`x${nasty}y.txt`)).toBe('xy.txt');
	});
});

describe('classify', () => {
	it.each([
		['a.pdf', 'application/pdf'],
		['a.PDF', 'application/pdf'],
		['a.txt', 'text/plain'],
		['a.md', 'text/markdown'],
		['a.csv', 'text/csv'],
		['a.json', 'application/json'],
		['a.zip', 'application/zip'],
		['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
		['a.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
		['a.mp4', 'video/mp4'],
		['a.mp3', 'audio/mpeg'],
		['evil.html', OCTET_STREAM],
		['evil.htm', OCTET_STREAM],
		['evil.svg', OCTET_STREAM],
		['evil.js', OCTET_STREAM],
		['evil.xml', OCTET_STREAM],
		['evil.exe', OCTET_STREAM],
		['noext', OCTET_STREAM],
		['.pdf', OCTET_STREAM],
		['a.constructor', OCTET_STREAM],
		['a.__proto__', OCTET_STREAM],
		['a.toString', OCTET_STREAM]
	])('%s → %s, never inline', (name, type) =>
		expect(classify(name, ascii('<html><script>'))).toEqual({
			contentType: type,
			inlineSafe: false
		})
	);

	it.each([
		['x.png', PNG, 'image/png'],
		['x.jpg', bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
		['x.jpeg', bytes(0xff, 0xd8, 0xff, 0xdb), 'image/jpeg'],
		['x.gif', ascii('GIF89a....'), 'image/gif'],
		['x.gif', ascii('GIF87a....'), 'image/gif'],
		['x.webp', ascii('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), 'image/webp']
	])('%s with real image bytes is inline-safe', (name, head, type) =>
		expect(classify(name, head)).toEqual({ contentType: type, inlineSafe: true })
	);

	it.each([
		['x.png', ascii('<svg onload=alert(1)>')],
		['x.png', bytes(0x89, 0x50)],
		['x.jpg', PNG],
		['x.gif', ascii('GIF90a')],
		['x.webp', ascii('RIFF\u0000\u0000\u0000\u0000AVI ')],
		['x.png', new Uint8Array(0)]
	])('%s whose bytes do not match is stored as octet-stream', (name, head) =>
		expect(classify(name, head)).toEqual({ contentType: OCTET_STREAM, inlineSafe: false })
	);
});

describe('contentDisposition', () => {
	it('plain ASCII', () =>
		expect(contentDisposition('attachment', 'report.pdf')).toBe(
			`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`
		));
	it('non-ASCII gets a safe fallback and RFC 5987 encoding', () =>
		expect(contentDisposition('attachment', 'Übersicht 🎉.pdf')).toBe(
			`attachment; filename="_bersicht __.pdf"; filename*=UTF-8''%C3%9Cbersicht%20%F0%9F%8E%89.pdf`
		));
	it('quotes, backslashes, percent signs and CR/LF never leave the parameter', () => {
		const header = contentDisposition('inline', 'a"b\\c%41\r\nSet-Cookie: x=1.txt');
		expect(header).not.toMatch(/[\r\n]/);
		expect(header.split('"')).toHaveLength(3);
		expect(header).toContain(`filename="a_b_c_41__Set-Cookie: x=1.txt"`);
		expect(header).toContain(`filename*=UTF-8''a%22b%5Cc%2541%0D%0ASet-Cookie%3A%20x%3D1.txt`);
	});
	it("encodes ' ( ) * which are not attr-chars", () =>
		expect(contentDisposition('attachment', "it's (a)*.txt")).toContain(
			`filename*=UTF-8''it%27s%20%28a%29%2A.txt`
		));
	it('a lone surrogate does not throw', () =>
		expect(() => contentDisposition('attachment', 'a\uD800b')).not.toThrow());
	it('a header built from it is accepted by Headers', () =>
		expect(
			() => new Headers({ 'content-disposition': contentDisposition('attachment', 'ü\u0085') })
		).not.toThrow());
});

describe('permissions', () => {
	const row = { uploadedBy: 'u1' };
	it('uploader and admin may delete, another member may not', () => {
		expect(canDeleteAttachment({ id: 'u1', role: 'member' }, row)).toBe(true);
		expect(canDeleteAttachment({ id: 'u2', role: 'admin' }, row)).toBe(true);
		expect(canDeleteAttachment({ id: 'u2', role: 'member' }, row)).toBe(false);
	});
});

describe('redirects', () => {
	it.each([
		['https://evil.example', '/kb/x', '/kb/x'],
		['//evil.example', '/kb/x', '/kb/x'],
		['/\\evil.example', '/kb/x', '/kb/x'],
		['javascript:alert(1)', '/kb/x', '/kb/x'],
		[null, '/kb/x', '/kb/x'],
		[null, null, '/'],
		['/projects/OPS/tasks/3', '/kb/x', '/projects/OPS/tasks/3']
	])('returnTo %j (target %j) → %j', (returnTo, target, path) =>
		expect(returnPath(returnTo, target)).toBe(path)
	);
	it('withFlash replaces old flash parameters and keeps the rest', () =>
		expect(withFlash('/kb/x?notice=saved&upload_error=limit#top', 'uploaded', '1')).toBe(
			'/kb/x?notice=saved&uploaded=1#attachments'
		));
});

const enc = new TextEncoder();

/** A multipart body as the browser would send it, plus its Content-Type. */
async function encode(form: FormData): Promise<{ type: string; raw: Uint8Array }> {
	const r = new Response(form);
	return { type: r.headers.get('content-type') ?? '', raw: new Uint8Array(await r.arrayBuffer()) };
}

/** `raw` as a pull stream of `size`-byte chunks that counts what was pulled. */
function chunked(raw: Uint8Array, size: number) {
	const stats = { pulled: 0 };
	let at = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(c) {
				if (at >= raw.length) return c.close();
				const chunk = raw.slice(at, at + size);
				at += chunk.length;
				stats.pulled += chunk.length;
				c.enqueue(chunk);
			}
		},
		{ highWaterMark: 0 }
	);
	return { stream, stats };
}

/** Every part of a body: header and text content. */
async function readAll(reader: MultipartReader) {
	const out: (PartHeader & { body: string })[] = [];
	for (let p = await reader.next(); p; p = await reader.next())
		out.push({ ...p, body: (await reader.text(1 << 20)) ?? '' });
	return out;
}

const request = (body: BodyInit | ReadableStream, headers: Record<string, string>) =>
	new Request('http://localhost/files', {
		method: 'POST',
		body,
		headers,
		duplex: 'half'
	} as RequestInit);

describe('multipart reader', () => {
	it('boundary parsing', () => {
		expect(multipartBoundary('multipart/form-data; boundary=abc')).toBe('abc');
		expect(multipartBoundary('Multipart/Form-Data; charset=x; boundary="a b:c"')).toBe('a b:c');
		expect(multipartBoundary('text/plain')).toBe('unsupported');
		expect(multipartBoundary(null)).toBe('unsupported');
		expect(multipartBoundary('multipart/form-data, text/html; boundary=x')).toBe('unsupported');
		expect(multipartBoundary('multipart/form-data')).toBe('bad_request');
		expect(multipartBoundary(`multipart/form-data; boundary=${'a'.repeat(71)}`)).toBe(
			'bad_request'
		);
		expect(multipartBoundary('multipart/form-data; boundary="a\r\n"')).toBe('bad_request');
	});

	it('Content-Disposition parsing', () => {
		expect(parseDispositionHeader(' form-data; name="file"; filename="a b.txt"')).toEqual({
			name: 'file',
			filename: 'a b.txt'
		});
		expect(parseDispositionHeader('form-data; name=targetId')).toEqual({
			name: 'targetId',
			filename: null
		});
		expect(parseDispositionHeader('form-data; name="f"; filename="q%22uo%0D%0Ate.txt"')).toEqual({
			name: 'f',
			filename: 'q"uo\r\nte.txt'
		});
		expect(
			parseDispositionHeader(`form-data; name="f"; filename="x"; filename*=UTF-8''%C3%9C.txt`)
		).toEqual({ name: 'f', filename: 'Ü.txt' });
		// A name="…" inside the filename is not the name.
		expect(parseDispositionHeader('form-data; filename="name=x"; name="file"')).toEqual({
			name: 'file',
			filename: 'name=x'
		});
		expect(parseDispositionHeader('attachment; name="f"')).toBeNull();
		expect(parseDispositionHeader('form-data; filename="a"')).toBeNull();
		expect(parseDispositionHeader('form-data; name="unterminated')).toBeNull();
		expect(parseDispositionHeader(`form-data; name="f"; filename*=UTF-8''%E0%A4%A`)).toBeNull();
	});

	it('indexOfBytes', () => {
		const hay = enc.encode('ab\r\n--x\r\n--xy');
		expect(indexOfBytes(hay, enc.encode('\r\n--xy'))).toBe(7);
		expect(indexOfBytes(hay, enc.encode('zz'))).toBe(-1);
		expect(indexOfBytes(enc.encode('ab'), enc.encode('abc'))).toBe(-1);
	});

	it('reads what a browser sends, in any chunking', async () => {
		const form = new FormData();
		form.set('targetKind', 'task');
		form.set('returnTo', '/kb/é');
		form.set('file', new File(['hello\r\n--almost a boundary\r\nworld'], 'a.txt'));
		const { type, raw } = await encode(form);
		const boundary = multipartBoundary(type) as string;
		for (const size of [1, 2, 3, 7, 64, 100_000]) {
			const parts = await readAll(new MultipartReader(chunked(raw, size).stream, boundary));
			expect(parts).toEqual([
				{ name: 'targetKind', filename: null, body: 'task' },
				{ name: 'returnTo', filename: null, body: '/kb/é' },
				{ name: 'file', filename: 'a.txt', body: 'hello\r\n--almost a boundary\r\nworld' }
			]);
		}
	});

	it('a preamble, transport padding and an epilogue are tolerated', async () => {
		const body = `preamble\r\n--b  \r\nContent-Disposition: form-data; name="x"\r\n\r\n1\r\n--b--\r\nepilogue`;
		const reader = new MultipartReader(chunked(enc.encode(body), 5).stream, 'b');
		expect(await readAll(reader)).toEqual([{ name: 'x', filename: null, body: '1' }]);
	});

	it.each([
		['a body cut off inside a part', '--b\r\nContent-Disposition: form-data; name="x"\r\n\r\nabc'],
		['no closing delimiter', '--b\r\nContent-Disposition: form-data; name="x"\r\n\r\nabc\r\n--b'],
		[
			'garbage after a delimiter',
			'--b\r\nContent-Disposition: form-data; name="x"\r\n\r\na\r\n--bXX'
		],
		['a part without Content-Disposition', '--b\r\nContent-Type: text/plain\r\n\r\na\r\n--b--'],
		[
			'two Content-Disposition headers',
			'--b\r\nContent-Disposition: form-data; name="x"\r\nContent-Disposition: form-data; name="y"\r\n\r\na\r\n--b--'
		],
		[
			'an endless header block',
			`--b\r\nContent-Disposition: form-data; name="x"\r\nX: ${'a'.repeat(10_000)}`
		],
		['not multipart at all', 'just text'],
		[
			'too many parts',
			`${'--b\r\nContent-Disposition: form-data; name="x"\r\n\r\n1\r\n'.repeat(20)}--b--`
		]
	])('%s is a bad request', async (_, body) => {
		const reader = new MultipartReader(chunked(enc.encode(body), 3).stream, 'b');
		await expect(readAll(reader)).rejects.toMatchObject({ reason: 'bad_request' });
	});

	it('a text field over its cap is read through and dropped', async () => {
		const body = `--b\r\nContent-Disposition: form-data; name="x"\r\n\r\n${'a'.repeat(5000)}\r\n--b--`;
		const reader = new MultipartReader(chunked(enc.encode(body), 512).stream, 'b');
		await reader.next();
		expect(await reader.text(4096)).toBeNull();
		expect(await reader.next()).toBeNull();
	});

	it('every byte counts against the bound, Content-Length or not', async () => {
		const form = new FormData();
		form.set('file', new File([new Uint8Array(4096)], 'a.bin'));
		const { type, raw } = await encode(form);
		const { stream, stats } = chunked(raw, 256);
		// A lying, small Content-Length changes nothing: the running count stops it.
		const reader = MultipartReader.open(
			request(stream, { 'content-type': type, 'content-length': '10' }),
			1024
		);
		expect(reader).toBeInstanceOf(MultipartReader);
		await expect(readAll(reader as MultipartReader)).rejects.toMatchObject({ reason: 'too_large' });
		expect(stats.pulled).toBeLessThanOrEqual(1024 + 256);
	});

	it('an oversized Content-Length is refused before a byte is read; other types are refused', () => {
		let pulled = false;
		const body = new ReadableStream({ pull: () => void (pulled = true) }, { highWaterMark: 0 });
		expect(
			MultipartReader.open(
				request(body, {
					'content-type': 'multipart/form-data; boundary=x',
					'content-length': String(
						ATTACHMENT_LIMITS.maxBytes + ATTACHMENT_LIMITS.bodyOverheadBytes + 1
					)
				})
			)
		).toBe('too_large');
		expect(pulled).toBe(false);
		expect(
			MultipartReader.open(request('a=1', { 'content-type': 'application/x-www-form-urlencoded' }))
		).toBe('unsupported');
		expect(MultipartReader.open(request('x', { 'content-type': 'multipart/form-data' }))).toBe(
			'bad_request'
		);
	});

	it('a body that stops arriving is cut at the deadline', async () => {
		const silent = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
		await expect(new MultipartReader(silent, 'b', 1024, 30).next()).rejects.toMatchObject({
			reason: 'bad_request'
		});
	});
});

/** An in-memory R2Bucket recording what each call received (not the bytes beyond their size). */
function memoryBucket() {
	const calls: { op: string; size?: number; contentType?: string }[] = [];
	const objects = new Map<string, Uint8Array>();
	const parts = new Map<number, Uint8Array>();
	const bucket = {
		put: async (key: string, value: Uint8Array, options?: R2PutOptions) => {
			calls.push({
				op: 'put',
				size: value.length,
				contentType: (options?.httpMetadata as R2HTTPMetadata)?.contentType
			});
			objects.set(key, value.slice());
		},
		delete: async (key: string) => {
			calls.push({ op: 'delete' });
			objects.delete(key);
		},
		createMultipartUpload: async (key: string, options?: R2MultipartOptions) => {
			calls.push({
				op: 'create',
				contentType: (options?.httpMetadata as R2HTTPMetadata)?.contentType
			});
			return {
				uploadPart: async (n: number, value: Uint8Array) => {
					calls.push({ op: 'part', size: value.length });
					parts.set(n, value.slice());
					return { partNumber: n, etag: String(n) };
				},
				complete: async (list: R2UploadedPart[]) => {
					calls.push({ op: 'complete' });
					const total = list.reduce((a, p) => a + (parts.get(p.partNumber)?.length ?? 0), 0);
					const all = new Uint8Array(total);
					let at = 0;
					for (const p of list) {
						const b = parts.get(p.partNumber) as Uint8Array;
						all.set(b, at);
						at += b.length;
					}
					objects.set(key, all);
				},
				abort: async () => {
					calls.push({ op: 'abort' });
				}
			};
		}
	} as unknown as R2Bucket;
	return { bucket, calls, objects };
}

const meta = (head: Uint8Array): R2PutOptions => ({
	httpMetadata: { contentType: classify('x.png', head).contentType }
});

describe('R2Writer', () => {
	it('a small file is one put of its bytes, typed from its first bytes', async () => {
		const { bucket, calls, objects } = memoryBucket();
		const w = new R2Writer(bucket, 'att/k', meta);
		await w.write(new Uint8Array([0x89, 0x50, 0x4e]));
		await w.write(new Uint8Array([0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]));
		await w.finish();
		expect(calls).toEqual([{ op: 'put', size: 10, contentType: 'image/png' }]);
		expect(objects.get('att/k')?.length).toBe(10);
	});

	it('exactly 25 MB is five 5 MiB parts; one byte more starts a sixth', async () => {
		const { bucket, calls, objects } = memoryBucket();
		const w = new R2Writer(bucket, 'att/k', meta);
		const chunk = new Uint8Array(1_000_000).fill(7);
		let left = ATTACHMENT_LIMITS.maxBytes;
		while (left > 0) {
			const n = Math.min(left, chunk.length);
			await w.write(chunk.subarray(0, n));
			left -= n;
		}
		await w.finish();
		expect(calls.filter((c) => c.op === 'part').map((c) => c.size)).toEqual(
			Array(5).fill(PART_BYTES)
		);
		expect(calls.at(-1)).toEqual({ op: 'complete' });
		expect(objects.get('att/k')?.length).toBe(ATTACHMENT_LIMITS.maxBytes);
		expect(w.peakBuffered).toBeLessThanOrEqual(PART_BYTES);
	});

	it('discard aborts an unfinished upload and deletes a finished object', async () => {
		const a = memoryBucket();
		const w = new R2Writer(a.bucket, 'att/k', meta);
		await w.write(new Uint8Array(PART_BYTES + 1));
		expect(await w.discard()).toBe(true);
		expect(a.calls.map((c) => c.op)).toEqual(['create', 'part', 'abort']);
		const b = memoryBucket();
		const v = new R2Writer(b.bucket, 'att/k', meta);
		await v.write(new Uint8Array(3));
		await v.finish();
		expect(await v.discard()).toBe(true);
		expect(b.objects.size).toBe(0);
	});
});

describe('memory bound (SECURITY_REPORT L1)', () => {
	it('a 25 MB upload streams through reader and writer holding at most one part plus a chunk', async () => {
		const size = ATTACHMENT_LIMITS.maxBytes;
		const boundary = 'BOUNDARY42';
		const head = enc.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n\r\n`
		);
		const tail = enc.encode(`\r\n--${boundary}--\r\n`);
		const CHUNK = 64 * 1024;
		let produced = 0;
		let sentToR2 = 0;
		let worstHeld = 0;
		// The body is generated as it is pulled: the test never holds 25 MB either.
		const total = head.length + size + tail.length;
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(c) {
					if (produced >= total) return c.close();
					const n = Math.min(CHUNK, total - produced);
					const out = new Uint8Array(n).fill(0x61);
					for (let i = 0; i < n; i++) {
						const at = produced + i;
						if (at < head.length) out[i] = head[at] as number;
						else if (at >= head.length + size) out[i] = tail[at - head.length - size] as number;
					}
					produced += n;
					worstHeld = Math.max(worstHeld, produced - sentToR2);
					c.enqueue(out);
				}
			},
			{ highWaterMark: 0 }
		);
		const { bucket, calls } = memoryBucket();
		const counting = {
			...bucket,
			createMultipartUpload: async (key: string, options?: R2MultipartOptions) => {
				const up = await bucket.createMultipartUpload(key, options);
				return {
					...up,
					uploadPart: async (n: number, value: Uint8Array) => {
						sentToR2 += value.length;
						return up.uploadPart(n, value as never);
					},
					complete: up.complete.bind(up),
					abort: up.abort.bind(up)
				};
			}
		} as unknown as R2Bucket;
		const reader = new MultipartReader(stream, boundary);
		const writer = new R2Writer(counting, 'att/k', meta);
		const part = await reader.next();
		expect(part?.filename).toBe('big.bin');
		expect(await reader.pipe((chunk) => writer.write(chunk))).toBe(size);
		expect(await reader.next()).toBeNull();
		await writer.finish();
		expect(calls.filter((c) => c.op === 'part')).toHaveLength(5);
		// Pulled from the client but not yet handed to R2, at any moment: one part, plus a chunk and the framing.
		expect(worstHeld).toBeLessThanOrEqual(PART_BYTES + 2 * CHUNK + head.length);
		expect(reader.peakBuffered).toBeLessThanOrEqual(CHUNK + 64);
		expect(writer.peakBuffered).toBeLessThanOrEqual(PART_BYTES);
	});
});
