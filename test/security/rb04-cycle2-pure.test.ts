import { describe, expect, it } from 'vitest';
import {
	MultipartError,
	MultipartReader,
	multipartBoundary,
	parseDispositionHeader,
	UPLOAD_BODY_MAX_BYTES
} from '#lib/server/attachments/multipart';
import { cleanFilename, fileExtension } from '#lib/server/attachments/filename';

/**
 * RB-04 cycle 2 red-team probes of the streaming multipart reader (docs/features/rb-04-attachments/SECURITY_REPORT.md
 * › Re-check after cycle 2): boundaries split at every chunk edge, partial-delimiter false positives, byte-exact
 * round trips of binary data full of CRLF and `--`, header and part bounds, and the CPU cost of pathological input.
 */

const enc = new TextEncoder();
const cat = (...parts: (Uint8Array | string)[]) => {
	const bs = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
	const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0));
	let at = 0;
	for (const b of bs) {
		out.set(b, at);
		at += b.length;
	}
	return out;
};

/** A body delivered in the given chunk sizes (cycled), each chunk a fresh copy. */
function streamOf(all: Uint8Array, sizes: number[] | ((i: number) => number)) {
	let at = 0;
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(c) {
			if (at >= all.length) return c.close();
			const n = Math.max(
				1,
				typeof sizes === 'function' ? sizes(i) : (sizes[i % sizes.length] ?? 1)
			);
			i += 1;
			c.enqueue(all.slice(at, at + n));
			at += n;
		}
	});
}

function body(boundary: string, file: Uint8Array, opts: { fields?: [string, string][] } = {}) {
	const fields = opts.fields ?? [
		['targetKind', 'task'],
		['targetId', '00000000-0000-4000-8000-000000000000']
	];
	return cat(
		...fields.flatMap(([k, v]) => [
			`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
		]),
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
		file,
		`\r\n--${boundary}--\r\n`
	);
}

/** Reads every part; text fields as strings, file parts as bytes. */
async function readAll(reader: MultipartReader) {
	const out: { name: string; filename: string | null; data: Uint8Array }[] = [];
	for (let p = await reader.next(); p; p = await reader.next()) {
		const chunks: Uint8Array[] = [];
		await reader.pipe((c) => {
			chunks.push(c.slice());
		});
		const data = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
		let at = 0;
		for (const c of chunks) {
			data.set(c, at);
			at += c.length;
		}
		out.push({ ...p, data });
	}
	return out;
}

const rng = (seed: number) => () => {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
};

/** Binary full of near-delimiters: CRLF, `--`, every proper prefix of the delimiter, and random bytes. */
function hostileBinary(boundary: string, n: number, seed = 7) {
	const rand = rng(seed);
	const delim = `\r\n--${boundary}`;
	const pieces: Uint8Array[] = [];
	let size = 0;
	while (size < n) {
		const r = rand();
		let p: Uint8Array;
		if (r < 0.3) p = enc.encode(delim.slice(0, 1 + Math.floor(rand() * (delim.length - 1))));
		else if (r < 0.4) p = enc.encode('\r\n--');
		else if (r < 0.5) p = enc.encode('--\r\n\r\n');
		else if (r < 0.55)
			p = enc.encode(`--${boundary}--`); // no leading CRLF: not a delimiter
		else {
			p = new Uint8Array(1 + Math.floor(rand() * 40));
			for (let i = 0; i < p.length; i++) p[i] = Math.floor(rand() * 256);
			// keep random bytes from forming the full delimiter by accident
		}
		pieces.push(p);
		size += p.length;
	}
	const all = cat(...pieces);
	// Make sure the full delimiter never occurs (it would legitimately end the part).
	const full = enc.encode(delim);
	for (;;) {
		const at = findBytes(all, full);
		if (at === -1) break;
		all[at + full.length - 1] = (all[at + full.length - 1] ?? 0) ^ 0x01;
	}
	return all;
}

function findBytes(hay: Uint8Array, needle: Uint8Array) {
	outer: for (let i = 0; i + needle.length <= hay.length; i++) {
		for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}

const expectReject = async (p: Promise<unknown>, reason: 'bad_request' | 'too_large') => {
	const e = await p.catch((x: unknown) => x);
	expect(e).toBeInstanceOf(MultipartError);
	expect((e as MultipartError).reason).toBe(reason);
};

describe('byte-exact round trip at every chunk edge', () => {
	const boundaries = [
		'B',
		'----WebKitFormBoundary7MA4YWxkTrZu0gW',
		'x'.repeat(70),
		"a'()+_,-./:=?b"
	];
	for (const boundary of boundaries) {
		it(`boundary ${boundary.length} chars: hostile binary survives chunk sizes 1..delimiter+3 and random`, async () => {
			const file = hostileBinary(boundary, 3000, boundary.length);
			const all = body(boundary, file);
			const dl = boundary.length + 4;
			const plans: (number[] | ((i: number) => number))[] = [];
			for (let s = 1; s <= dl + 3; s++) plans.push([s]);
			const r = rng(99);
			plans.push(() => 1 + Math.floor(r() * 200));
			plans.push([dl - 1, 1, dl, 2, dl + 1]);
			for (const plan of plans) {
				const reader = new MultipartReader(streamOf(all, plan), boundary);
				const parts = await readAll(reader);
				expect(parts.map((p) => p.name)).toEqual(['targetKind', 'targetId', 'file']);
				expect(parts[2]?.data).toEqual(file);
				expect(new TextDecoder().decode(parts[0]?.data)).toBe('task');
			}
		});
	}

	it('a file that is only a delimiter prefix, or ends in one, round trips (tail held back correctly)', async () => {
		const b = 'BOUNDARY';
		for (const file of [
			'\r',
			'\r\n',
			'\r\n-',
			'\r\n--',
			'\r\n--BOUNDAR',
			'abc\r\n--BOUNDAR',
			'\r\n\r\n--B'
		]) {
			for (let s = 1; s <= 14; s++) {
				const parts = await readAll(
					new MultipartReader(streamOf(body(b, enc.encode(file)), [s]), b)
				);
				expect(new TextDecoder().decode(parts[2]?.data)).toBe(file);
			}
		}
	});

	it('the full delimiter inside the file ends the part (RFC 2046); what follows must be CRLF or "--"', async () => {
		const b = 'BOUND';
		const file = enc.encode('head\r\n--BOUNDjunk');
		await expectReject(
			readAll(new MultipartReader(streamOf(body(b, file), [5]), b)),
			'bad_request'
		);
	});
});

describe('boundary parameter', () => {
	it('1–70 chars, quoted or not, case-insensitive parameter; 71 chars, empty, trailing space or a quote refused', () => {
		expect(multipartBoundary('multipart/form-data; boundary=abc')).toBe('abc');
		expect(multipartBoundary('Multipart/Form-Data;BOUNDARY="a b"')).toBe('a b');
		expect(multipartBoundary(`multipart/form-data; boundary=${'x'.repeat(70)}`)).toBe(
			'x'.repeat(70)
		);
		expect(multipartBoundary(`multipart/form-data; boundary=${'x'.repeat(71)}`)).toBe(
			'bad_request'
		);
		expect(multipartBoundary('multipart/form-data; boundary=')).toBe('bad_request');
		expect(multipartBoundary('multipart/form-data; boundary="ab "')).toBe('bad_request');
		expect(multipartBoundary('multipart/form-data')).toBe('bad_request');
		expect(multipartBoundary('multipart/form-data, text/html; boundary=a')).toBe('unsupported');
		expect(multipartBoundary('multipart/mixed; boundary=a')).toBe('unsupported');
	});

	it('INFO: the first `; boundary=` wins, even inside another quoted parameter (parser differential only)', () => {
		expect(multipartBoundary('multipart/form-data; x="; boundary=evil;"; boundary=real')).toBe(
			'evil'
		);
		// Junk after a closing quote is ignored rather than refused.
		expect(multipartBoundary('multipart/form-data; boundary="a"b"')).toBe('a');
	});
});

describe('part headers', () => {
	const b = 'B';
	const raw = (s: string) => new MultipartReader(streamOf(enc.encode(s), [7]), b);

	it('folded, duplicate or missing Content-Disposition, or a non form-data one: refused', async () => {
		for (const h of [
			'Content-Disposition: form-data;\r\n name="file"; filename="a"',
			'Content-Disposition: form-data; name="a"\r\nContent-Disposition: form-data; name="file"; filename="b"',
			'Content-Type: text/plain',
			'Content-Disposition: attachment; name="file"; filename="a"',
			'Content-Disposition: form-data; filename="a"'
		])
			await expectReject(readAll(raw(`--B\r\n${h}\r\n\r\nx\r\n--B--`)), 'bad_request');
	});

	it('a header block over 8 KiB, or one that never ends, is refused without reading the rest of the body', async () => {
		const long = `--B\r\nContent-Disposition: form-data; name="file"; filename="${'a'.repeat(9000)}"\r\n\r\nx\r\n--B--`;
		await expectReject(readAll(raw(long)), 'bad_request');
		let pulled = 0;
		const endless = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(enc.encode('--B\r\nContent-Disposition: form-data; name="a"'));
			},
			pull(c) {
				pulled += 1;
				c.enqueue(enc.encode('x'.repeat(1024)));
			}
		});
		await expectReject(readAll(new MultipartReader(endless, b)), 'bad_request');
		expect(pulled).toBeLessThan(20);
	});

	it('more than 16 parts is refused', async () => {
		const many = Array.from(
			{ length: 17 },
			(_, i) => `--B\r\nContent-Disposition: form-data; name="f${i}"\r\n\r\nv\r\n`
		).join('');
		await expectReject(readAll(raw(`${many}--B--`)), 'bad_request');
	});

	it('missing final boundary, garbage after a delimiter, or a body that stops mid-part: refused', async () => {
		await expectReject(
			readAll(raw('--B\r\nContent-Disposition: form-data; name="a"\r\n\r\nv')),
			'bad_request'
		);
		await expectReject(
			readAll(raw('--B\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n--B')),
			'bad_request'
		);
		await expectReject(
			readAll(raw('--B\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n--BX')),
			'bad_request'
		);
	});

	it('a boundary string inside a quoted filename is just a name', async () => {
		const parts = await readAll(
			raw(
				'--B\r\nContent-Disposition: form-data; name="file"; filename="--B--.txt"\r\n\r\nok\r\n--B--\r\n'
			)
		);
		expect(parts[0]?.filename).toBe('--B--.txt');
		expect(new TextDecoder().decode(parts[0]?.data)).toBe('ok');
	});

	it('filename* overrides; bad percent-encoding refused; first duplicate parameter wins', () => {
		expect(
			parseDispositionHeader(
				`form-data; name="file"; filename="a.png"; filename*=UTF-8''b%E2%80%AE.exe`
			)?.filename
		).toBe('b‮.exe');
		expect(cleanFilename('b‮.exe')).toBe('b.exe');
		expect(parseDispositionHeader(`form-data; name="file"; filename*=UTF-8''%ZZ`)).toBeNull();
		expect(parseDispositionHeader('form-data; name="file"; name="targetId"')?.name).toBe('file');
	});
});

describe('size, memory and time bounds', () => {
	it('a field that never ends is cut at the body bound (chunked, no Content-Length)', async () => {
		let sent = 0;
		const s = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(enc.encode('--B\r\nContent-Disposition: form-data; name="targetId"\r\n\r\n'));
			},
			pull(c) {
				sent += 65536;
				c.enqueue(new Uint8Array(65536).fill(0x41));
			}
		});
		const r = new MultipartReader(s, 'B');
		await r.next();
		await expectReject(r.text(4096), 'too_large');
		expect(sent).toBeLessThanOrEqual(UPLOAD_BODY_MAX_BYTES + 65536);
		expect(r.peakBuffered).toBeLessThan(70_000);
	});

	it('a trickle is cut at the deadline', async () => {
		const s = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(
					enc.encode('--B\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\n')
				);
			},
			async pull(c) {
				await new Promise((r) => setTimeout(r, 20));
				c.enqueue(enc.encode('x'));
			}
		});
		const r = new MultipartReader(s, 'B', UPLOAD_BODY_MAX_BYTES, 150);
		await r.next();
		const t = Date.now();
		await expectReject(
			r.pipe(() => {}),
			'bad_request'
		);
		expect(Date.now() - t).toBeLessThan(1000);
	});

	it('CPU: pathological bodies parse in linear time', async () => {
		const b = 'z'.repeat(70);
		const near = enc.encode(`\r\n--${b.slice(0, 69)}y`);
		const n = 25 * 1024 * 1024;
		const evil = new Uint8Array(n);
		for (let i = 0; i + near.length <= n; i += near.length) evil.set(near, i);
		const crs = new Uint8Array(n).fill(0x0d);
		const timings: Record<string, number> = {};
		for (const [label, file] of [
			['near-delimiters', evil],
			['all CR', crs]
		] as const) {
			const t = performance.now();
			const r = new MultipartReader(streamOf(body(b, file), [65536]), b);
			const parts = await readAll(r);
			timings[label] = performance.now() - t;
			expect(parts[2]?.data.length).toBe(n);
			expect(r.peakBuffered).toBeLessThan(65536 + 200);
		}
		console.info('rb04-cycle2 cpu 25 MiB @64K chunks (ms)', timings);
		for (const ms of Object.values(timings)) expect(ms).toBeLessThan(5000);
	});

	it('CPU: 1-byte chunks (a hostile trickle) cost per chunk, bounded by the body size', async () => {
		const header = enc.encode(
			`--B\r\nContent-Disposition: form-data; name="file"; filename="${'a'.repeat(8000)}"\r\n\r\n`
		);
		let t = performance.now();
		const many = cat(...Array.from({ length: 16 }, () => header), '--B--');
		// 16 header blocks of ~8 KiB, one byte per read: the header search re-scans the buffer each time.
		const hr = new MultipartReader(streamOf(many, [1]), 'B');
		for (let p = await hr.next().catch(() => null); p; p = await hr.next().catch(() => null));
		const headerMs = performance.now() - t;
		t = performance.now();
		const mib = new Uint8Array(1024 * 1024).fill(0x61);
		const br = new MultipartReader(streamOf(body('B', mib), [1]), 'B');
		await readAll(br);
		const bodyMs = performance.now() - t;
		console.info('rb04-cycle2 cpu 1-byte chunks (ms)', {
			headers16x8K: headerMs,
			body1MiB: bodyMs
		});
	});
});

describe('L2 badge', () => {
	it('the badge is the real last extension, after cleaning', () => {
		const name = cleanFilename('invoice.pdf' + 'ㅤ'.repeat(60) + '.exe');
		expect(name).toBe('invoice.pdf.exe');
		expect(fileExtension(name)).toBe('exe');
		expect(fileExtension(cleanFilename('report.pdf' + ' '.repeat(80) + '.scr'))).toBe('scr');
	});

	it('blank-looking code points outside the strip set (probe)', () => {
		const candidates = [
			' ',
			'　',
			' ',
			' ',
			' ',
			' ',
			'\u{1d159}',
			'\u{1d173}',
			'\u{e0020}',
			'\u{16fe4}',
			'\u{1bca0}',
			'⁡',
			'༌'
		];
		const kept = candidates.filter((c) => cleanFilename(`a${c.repeat(3)}b.txt`).includes(c));
		console.info(
			'rb04-cycle2 kept blank-ish',
			kept.map((c) => c.codePointAt(0)?.toString(16))
		);
	});
});
