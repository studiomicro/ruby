import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { isCrossSiteForm } from '#lib/server/csrf';
import { noticeFor } from '#lib/server/kb/load';
import { checkBody, checkTitle, parsePlacement, parseParentId } from '#lib/server/kb/validation';
import { buildMatchQuery, splitMarkedSnippet } from '#lib/server/search/query';
import { renderMarkdown } from '#lib/shared/markdown';
import Highlighted from '../../src/routes/(app)/search/Highlighted.svelte';

/**
 * RB-02 red-team probes that need no database (docs/features/rb-02-knowledge-base/SECURITY_REPORT.md): the FTS5
 * MATCH builder against hostile input, snippet highlighting, Markdown XSS through page bodies, form parsers.
 */

/**
 * Every MATCH expression must be quoted terms only (`"tok"*`, or `"t"` for a one-character token since the L2
 * fix): no bare operator, column filter, `^`, NEAR, parenthesis.
 */
const SAFE_MATCH = /^"[^"]+"\*?( "[^"]+"\*?){0,7}$/u;
/** L2 (fixed): only terms of two or more characters are prefix queries. */
const prefixOnlyIfLong = (m: string) => {
	for (const term of m.split(' ')) {
		const inner = term.replace(/\*$/, '').slice(1, -1);
		expect(term.endsWith('*'), term).toBe(Array.from(inner).length > 1);
	}
};

describe('buildMatchQuery: FTS5 operator and column injection', () => {
	const hostile = [
		'title:secret',
		'body : x',
		'{title body}: x',
		'- title: x',
		'NEAR(a b, 0)',
		'NEAR/1',
		'a NEAR b',
		'^start',
		'a AND b OR c NOT d',
		'"unbalanced',
		'""""',
		'a"b',
		'(a OR b',
		'a* b* c*',
		'*',
		'+-*^:()',
		'a\u0000b',
		'‮abc',
		'pages_fts',
		"x'); DROP TABLE pages; --",
		'é" OR "1',
		'ｔｉｔｌｅ：ｘ' // full-width colon (NFKC folds it to ':')
	];
	for (const q of hostile)
		it(`${JSON.stringify(q)} becomes quoted prefix terms only`, () => {
			const m = buildMatchQuery(q);
			if (m === null) return;
			expect(m).toMatch(SAFE_MATCH);
			prefixOnlyIfLong(m);
			// Inside each quoted term there is no quote at all (the splitter removes them).
			for (const term of m.split(' '))
				expect(term.replace(/\*$/, '').slice(1, -1)).not.toContain('"');
		});

	it('random fuzz: 5000 inputs over the operator alphabet stay inside the safe grammar', () => {
		const alphabet = [
			'"',
			'*',
			'^',
			':',
			'(',
			')',
			'-',
			'+',
			' ',
			'NEAR',
			'AND',
			'OR',
			'NOT',
			'a',
			'é',
			'{',
			'}',
			',',
			'\u0000',
			'：'
		];
		let seed = 42;
		const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
		for (let i = 0; i < 5000; i++) {
			let q = '';
			const n = 1 + Math.floor(rnd() * 30);
			for (let j = 0; j < n; j++) q += alphabet[Math.floor(rnd() * alphabet.length)];
			const m = buildMatchQuery(q);
			if (m !== null) {
				expect(m, JSON.stringify(q)).toMatch(SAFE_MATCH);
				prefixOnlyIfLong(m);
			}
		}
	});

	it('DoS bounds: at most 8 terms of at most 64 characters, from at most 200 input characters', () => {
		const many = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(' ');
		expect(buildMatchQuery(many)?.split(' ')).toHaveLength(8);
		expect(buildMatchQuery('x'.repeat(65))).toBeNull();
		expect(buildMatchQuery('x'.repeat(64))).toBe(`"${'x'.repeat(64)}"*`);
		// A megabyte of input costs a slice, not a regex over a megabyte.
		const t0 = performance.now();
		buildMatchQuery('a '.repeat(500_000));
		expect(performance.now() - t0).toBeLessThan(200);
	});
});

describe('snippet highlighting renders text, never markup', () => {
	it('markers around hostile text give only <mark> elements with escaped content', () => {
		const s =
			'\u0001<img src=x onerror=alert(1)>\u0002 and </mark><script>x</script>\u0002\u0001"><svg onload=1>';
		const segments = splitMarkedSnippet(s);
		const html = render(Highlighted, { props: { segments } }).body;
		const tags = [...html.matchAll(/<\/?([a-z][a-z0-9-]*)/gi)].map((m) => m[1]);
		expect(new Set(tags)).toEqual(new Set(['mark']));
		expect(html).toContain('&lt;img');
	});
});

describe('Markdown XSS through page bodies (only renderMarkdown makes HTML)', () => {
	const payloads = [
		'<script>alert(1)</script>',
		'<img src=x onerror=alert(1)>',
		'[x](javascript:alert(1))',
		'[x](JaVaScRiPt:alert(1))',
		'[x](java&#x09;script:alert(1))',
		'[x](&#106;avascript:alert(1))',
		'[x](vbscript:msgbox(1))',
		'[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
		'![x](data:image/svg+xml,<svg onload=alert(1)>)',
		'[x][r]\n\n[r]: javascript:alert(1)',
		'<javascript:alert(1)>',
		'[x](//evil.example)',
		'[x](\\\\evil.example)',
		'[x]( javascript:alert(1))',
		'[x](<javascript:alert(1)>)',
		'`<script>`<script>alert(1)</script>',
		'[<img src=x onerror=1>](https://ok.example)',
		'[x](https://ok.example "a\\" onmouseover=\\"alert(1)")',
		'@[<b>x</b>](user:00000000-0000-4000-8000-000000000000)'
	];
	for (const p of payloads)
		it(JSON.stringify(p), () => {
			const html = renderMarkdown(p);
			// Real tags only (escaped text such as `&lt;img` is not a tag): allowed elements and attributes.
			for (const [, tag, attrs] of html.matchAll(
				/<([a-z][a-z0-9]*)((?:\s+[a-z-]+="[^"]*")*)\s*\/?>/gi
			)) {
				expect(['p', 'a', 'code', 'span', 'img', 'em', 'strong', 'pre', 'br']).toContain(tag);
				for (const [, name, value] of (attrs ?? '').matchAll(/([a-z-]+)="([^"]*)"/gi)) {
					expect(['href', 'src', 'alt', 'title', 'rel', 'class']).toContain(name);
					if (name === 'href' || name === 'src') {
						expect(value).not.toMatch(/^\s*(javascript|vbscript|data|file):/i);
						expect(value).not.toMatch(/^\/\/|^\\/);
					}
				}
			}
			expect(html).not.toMatch(/<script|<svg|<iframe/i);
		});
	// Render cost of pathological 200 KB bodies is measured by rb00-pure.test.ts (shared renderer); see report L4.
});

describe('form parsers and notices', () => {
	it('parent and placement ids accept uuids only', () => {
		expect(parseParentId('x OR 1=1')).toBeUndefined();
		expect(parseParentId("' OR ''='")).toBeUndefined();
		expect(parsePlacement('after:../x')).toBeNull();
		expect(parsePlacement('after:00000000-0000-4000-8000-00000000000g')).toBeNull();
	});

	it('the notice banner shows only fixed text and digits (no reflected input)', () => {
		const u = new URL('http://localhost/kb?notice=restored&from=<script>&to=2');
		expect(noticeFor(u)).toBe('Revision restored.');
		expect(noticeFor(new URL('http://localhost/kb?notice=__proto__'))).toBeNull();
		expect(noticeFor(new URL('http://localhost/kb?notice=constructor'))).toBeNull();
	});

	it('titles strip bidi and control characters; bodies strip NUL and the highlight markers', () => {
		expect(checkTitle('a‮b\u0000c​d').value).toBe('abcd');
		expect(checkBody('x\u0000\u0001\u0002y\r\nz').value).toBe('xy\nz');
		expect(checkBody('a'.repeat(200_001)).error).toBeDefined();
	});

	it('every KB action is covered by the global cross-site form check (multipart included)', () => {
		for (const type of [
			'multipart/form-data; boundary=x',
			'application/x-www-form-urlencoded',
			'text/plain'
		])
			for (const origin of [null, 'https://evil.example', 'null']) {
				const headers = new Headers({ 'content-type': type });
				if (origin) headers.set('origin', origin);
				const req = new Request('https://ruby.example/kb/x/delete?/delete', {
					method: 'POST',
					headers
				});
				expect(isCrossSiteForm(req, 'https://ruby.example')).toBe(true);
			}
	});
});
