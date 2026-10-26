import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { MultipartReader } from '#lib/server/attachments/multipart';
import { classify, INLINE_TYPES } from '#lib/server/attachments/content-type';
import { contentDisposition } from '#lib/server/attachments/disposition';
import { cleanFilename, fileExtension } from '#lib/server/attachments/filename';
import { returnPath, withFlash } from '#lib/server/attachments/respond';
import { isCrossSiteForm } from '#lib/server/csrf';
import type { AttachmentPanelData } from '#lib/shared/attachments';
vi.mock('$app/navigation', () => ({ invalidateAll: async () => {} }));
const { default: AttachmentPanel } =
	await import('../../src/lib/ui/attachments/AttachmentPanel.svelte');

/**
 * RB-04 red-team probes that need no database (docs/features/rb-04-attachments/SECURITY_REPORT.md): file-name
 * cleaning, MIME classification and polyglots, Content-Disposition header injection, the streaming body bound with a
 * lying or missing Content-Length, redirect targets, CSRF classification, and file names in the panel markup.
 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bytes = (...parts: (number[] | string)[]) =>
	new Uint8Array(
		parts.flatMap((p) => (typeof p === 'string' ? [...new TextEncoder().encode(p)] : p))
	);

/** RFC 6266 / RFC 5987 parse of what a browser reads from the header. */
function parseDisposition(value: string) {
	const m =
		/^(attachment|inline); filename="([\x20-\x21\x23-\x5b\x5d-\x7e]*)"; filename\*=UTF-8''([A-Za-z0-9!#$&+\-.^_`|~%]*)$/.exec(
			value
		);
	if (!m) return null;
	return { kind: m[1], fallback: m[2], star: decodeURIComponent(m[3] ?? '') };
}

describe('file names: traversal, invisibles, device names', () => {
	const hostile = [
		'../../etc/passwd',
		'..\\..\\windows\\win.ini',
		'evil.html\u0000.png',
		'a‮gnp.exe',
		'a⁦gnp⁩.exe',
		'x\r\nSet-Cookie: a=b.txt',
		'"; filename=evil.html; x=".txt',
		'name;with;semicolons,and=equals.txt',
		'CON.txt',
		'con .tar.gz',
		'AUX..',
		'nul​.txt',
		'....',
		'',
		'\u0085  ﻿',
		'\ud800lonely-surrogate.txt',
		'emoji-😀-名前-café.pdf',
		'x'.repeat(5000) + '.html',
		'a'.repeat(300),
		'%2e%2e%2fetc%2fpasswd',
		'.htaccess',
		'evil.svg ',
		'evil.html.'
	];

	it('never keeps a path separator, control, bidi or quote; never longer than 120; never empty', () => {
		for (const raw of hostile) {
			const name = cleanFilename(raw);
			expect(name.length).toBeGreaterThan(0);
			expect(Array.from(name).length).toBeLessThanOrEqual(120);
			expect(name).not.toMatch(/[/\\:*?"<>|]/);
			expect(name).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
			expect(name).not.toMatch(/^[\s.]|[\s.]$/);
			expect(name).not.toMatch(/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i);
		}
	});

	it('trailing-dot and trailing-space tricks lose the dot, so the served type follows the visible name', () => {
		expect(cleanFilename('evil.html.')).toBe('evil.html');
		expect(classify(cleanFilename('evil.html.'), new Uint8Array()).contentType).toBe(
			'application/octet-stream'
		);
		expect(cleanFilename('evil.svg ')).toBe('evil.svg');
		// A NUL between two extensions is removed: the name and its type agree on ".png", and a non-PNG body is octet.
		const nul = cleanFilename('evil.html\u0000.png');
		expect(nul).toBe('evil.html.png');
		expect(classify(nul, bytes('<html><script>alert(1)</script>')).contentType).toBe(
			'application/octet-stream'
		);
	});

	it('LOW L2 (fixed): invisible "letter" fillers and other default-ignorables are stripped', () => {
		const padded = cleanFilename(`invoice.pdf${'\u3164'.repeat(60)}.exe`);
		expect(padded).toBe('invoice.pdf.exe');
		expect(fileExtension(padded)).toBe('exe');
		for (const blank of [
			'\u3164',
			'\u2800',
			'\u115F',
			'\u1160',
			'\uFFA0',
			'\u180E',
			'\u034F',
			'\uFE0F',
			'\u2060'
		])
			expect(cleanFilename(`a${blank.repeat(10)}.exe`), blank.codePointAt(0)?.toString(16)).toBe(
				'a.exe'
			);
		// Visible letters stay.
		expect(cleanFilename('한국어 文書.pdf')).toBe('한국어 文書.pdf');
	});
});

describe('MIME classification and polyglots', () => {
	it('active content is octet-stream whatever its case or double extension; never inline', () => {
		for (const name of [
			'evil.html',
			'EVIL.HTM',
			'evil.svg',
			'evil.SVG',
			'evil.xml',
			'evil.xhtml',
			'evil.js',
			'evil.mjs',
			'evil.css',
			'evil.png.html',
			'evil.jpg.svg',
			'evil.swf',
			'evil.exe',
			'evil',
			'evil.',
			'evil.__proto__',
			'evil.constructor',
			'evil.toString'
		]) {
			const c = classify(name, bytes(PNG_MAGIC, '<svg onload=alert(1)>'));
			expect(c, name).toEqual({ contentType: 'application/octet-stream', inlineSafe: false });
		}
	});

	it('a PNG header with an HTML body named .png is image/png (nosniff renders it as an image, never HTML)', () => {
		const c = classify('evil.png', bytes(PNG_MAGIC, '<html><script>alert(1)</script>'));
		expect(c).toEqual({ contentType: 'image/png', inlineSafe: true });
		expect(INLINE_TYPES.has('image/svg+xml')).toBe(false);
		expect(INLINE_TYPES.has('text/html')).toBe(false);
	});

	it('an image extension without its magic number is octet-stream (GIFAR, HTML-as-JPEG, truncated magic)', () => {
		expect(classify('x.jpg', bytes('<html>')).contentType).toBe('application/octet-stream');
		expect(classify('x.gif', bytes('GIF88a')).contentType).toBe('application/octet-stream');
		expect(classify('x.png', bytes([0x89, 0x50, 0x4e, 0x47])).contentType).toBe(
			'application/octet-stream'
		);
		expect(classify('x.webp', bytes('RIFF\0\0\0\0WAVE')).contentType).toBe(
			'application/octet-stream'
		);
	});
});

describe('Content-Disposition: no header injection, valid RFC 5987', () => {
	const samples = [
		'x\r\nSet-Cookie: a=b.txt',
		'"; filename=evil.html; x=".txt',
		'a\\"b.txt',
		'100% real.pdf',
		"it's (a) *test*.txt",
		'名前.pdf',
		'emoji-😀.png',
		'semi;colon,comma=eq.txt',
		'\ud800lonely.txt',
		'x'.repeat(5000),
		'a‮gnp.exe'
	];

	it('every cleaned name gives a header Headers accepts, parses as one parameter pair and decodes back', () => {
		for (const raw of samples) {
			const name = cleanFilename(raw);
			for (const kind of ['attachment', 'inline'] as const) {
				const value = contentDisposition(kind, name);
				expect(() => new Headers({ 'content-disposition': value })).not.toThrow();
				expect(value).not.toMatch(/[\r\n]/);
				const parsed = parseDisposition(value);
				expect(parsed, value).not.toBeNull();
				expect(parsed?.kind).toBe(kind);
				expect(parsed?.star).toBe(name);
			}
		}
	});

	it('the backstop holds even for an uncleaned name (CR/LF, quotes, lone surrogate)', () => {
		for (const raw of samples) {
			const value = contentDisposition('attachment', raw);
			expect(value).not.toMatch(/[\r\n]/);
			expect(parseDisposition(value), value).not.toBeNull();
		}
	});
});

/** Reads every part of `request` within `max` bytes (streaming): 'ok', or why it was refused. */
async function readBody(request: Request, max?: number): Promise<string> {
	const reader = MultipartReader.open(request, max);
	if (typeof reader === 'string') return reader;
	try {
		for (let p = await reader.next(); p; p = await reader.next()) await reader.pipe(() => {});
		return 'ok';
	} catch (e) {
		return (e as { reason?: string }).reason ?? 'error';
	}
}

describe('upload body bound', () => {
	const multipart = (size: number) => {
		const boundary = 'xBOUNDARYx';
		const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`;
		const tail = `\r\n--${boundary}--\r\n`;
		return {
			type: `multipart/form-data; boundary=${boundary}`,
			chunks: [new TextEncoder().encode(head), new Uint8Array(size), new TextEncoder().encode(tail)]
		};
	};
	const streamOf = (chunks: Uint8Array[]) =>
		new ReadableStream<Uint8Array>({
			start(c) {
				for (const ch of chunks) c.enqueue(ch);
				c.close();
			}
		});

	it('a body larger than its declared (lying, small) Content-Length is cut at the bound', async () => {
		const { type, chunks } = multipart(4096);
		const request = new Request('http://localhost/files', {
			method: 'POST',
			body: streamOf(chunks),
			headers: { 'content-type': type, 'content-length': '10' },
			duplex: 'half'
		} as RequestInit);
		expect(await readBody(request, 1024)).toBe('too_large');
	});

	it('a chunked body with no Content-Length is cut at the bound', async () => {
		const { type, chunks } = multipart(4096);
		const request = new Request('http://localhost/files', {
			method: 'POST',
			body: streamOf(chunks),
			headers: { 'content-type': type },
			duplex: 'half'
		} as RequestInit);
		expect(request.headers.get('content-length')).toBeNull();
		expect(await readBody(request, 1024)).toBe('too_large');
	});

	it('an oversized declared length is refused without pulling a byte', async () => {
		let pulled = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(c) {
				pulled += 1;
				c.enqueue(new Uint8Array(10));
			}
		});
		const request = new Request('http://localhost/files', {
			method: 'POST',
			body,
			headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '999999999' },
			duplex: 'half'
		} as RequestInit);
		expect(await readBody(request, 1024)).toBe('too_large');
		expect(pulled).toBeLessThanOrEqual(1); // the stream's own first pull on construction, never consumed
	});

	it('a body that never ends is cut at the timeout', async () => {
		const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
		await expect(new MultipartReader(stalled, 'x', 1024, 50).next()).rejects.toMatchObject({
			reason: 'bad_request'
		});
	});

	it('non-multipart types are refused (text/plain, JSON, a list hiding multipart)', async () => {
		for (const type of ['text/plain', 'application/json', 'multipart/form-data, text/html', '']) {
			const request = new Request('http://localhost/files', {
				method: 'POST',
				body: 'x',
				headers: type ? { 'content-type': type } : {}
			});
			if (!type) request.headers.delete('content-type');
			expect(await readBody(request)).not.toBe('ok');
		}
	});
});

describe('redirect after upload or delete', () => {
	it('external, protocol-relative, backslash and encoded targets fall back to the target page', () => {
		for (const bad of [
			'https://evil.example',
			'//evil.example',
			'/\\evil.example',
			'\\\\evil.example',
			'/%2F%2Fevil.example',
			'/%252F%252Fevil.example',
			'/\t/evil.example',
			'javascript:alert(1)',
			'/./\\evil.example',
			'https:evil.example'
		])
			expect(returnPath(bad, '/projects/OPS/tasks/1'), bad).toBe('/projects/OPS/tasks/1');
		expect(withFlash('/kb/x?uploaded=1&upload_error=limit', 'uploaded', '1')).toBe(
			'/kb/x?uploaded=1#attachments'
		);
	});
});

describe('CSRF classification of the upload and delete posts', () => {
	const req = (headers: Record<string, string>) =>
		new Request('http://localhost/files', { method: 'POST', headers });
	it('cross-site, Origin-less and null-Origin multipart/urlencoded/no-type posts are refused', () => {
		for (const origin of ['https://evil.example', 'null', undefined])
			for (const type of [
				'multipart/form-data; boundary=x',
				'MULTIPART/FORM-DATA; boundary=x',
				'application/x-www-form-urlencoded',
				'text/plain',
				undefined
			]) {
				const h: Record<string, string> = {};
				if (origin) h.origin = origin;
				if (type) h['content-type'] = type;
				expect(isCrossSiteForm(req(h), 'http://localhost'), `${origin} ${type}`).toBe(true);
			}
	});
});

describe('panel markup', () => {
	it('a hostile file name and uploader name render as text, never markup', () => {
		const evil = '<img src=x onerror=alert(1)>"\'><script>alert(2)</script>.txt';
		const panel: AttachmentPanelData = {
			targetKind: 'task',
			targetId: crypto.randomUUID(),
			returnTo: '/projects/OPS/tasks/1"><script>alert(3)</script>',
			items: [
				{
					id: crypto.randomUUID(),
					filename: evil,
					extension: 'txt',
					sizeBytes: 10,
					image: true,
					uploaderName: '<b onmouseover=alert(4)>x</b>',
					createdAt: Date.now(),
					canDelete: true
				}
			],
			max: 20,
			maxBytes: 26_214_400,
			flash: null
		};
		const { body } = render(AttachmentPanel, { props: { panel } });
		expect(body).not.toContain('<script>');
		expect(body).not.toContain('<img src=x');
		expect(body).not.toContain('<b onmouseover');
		// Every `<` from the data is escaped; the only <img> is the thumbnail with a server-made src.
		expect(body.match(/<img /g)?.length).toBe(1);
		expect(body).toContain('&lt;img src=x onerror=alert(1)>');
		expect(body).not.toContain('"><script>');
	});
});
