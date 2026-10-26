import { describe, expect, it } from 'vitest';
import {
	extractMentionIds,
	isSafeUrl,
	MENTIONS_MAX,
	mentionMarkup,
	renderMarkdown,
	UNKNOWN_USER
} from './markdown';

const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const ID2 = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d';

/** Every href/src in the output. */
const urls = (html: string) =>
	[...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1] ?? '');
/**
 * The attribute names of every real start tag in the output. markdown-it always writes `name="value"` with `"`, `<`
 * and `>` escaped inside the value, so a value can never end early; escaped text such as `&lt;img onerror=…&gt;`
 * is not a tag at all.
 */
function attributeNames(html: string): string[] {
	const names: string[] = [];
	for (const tag of html.matchAll(/<([a-z][a-z0-9]*)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*\/?>/gi))
		for (const attr of (tag[2] ?? '').matchAll(/\s+([a-z-]+)(?:="[^"]*")?/gi))
			names.push(attr[1] ?? '');
	return names;
}

/** Asserts the output has no live script vector at all. */
function assertInert(html: string) {
	expect(html).not.toMatch(/<script/i);
	expect(html).not.toMatch(/<(iframe|object|embed|svg|math|style|form|input|base|meta|link)\b/i);
	expect(attributeNames(html).filter((name) => /^on/i.test(name))).toEqual([]);
	// Every `<` in the output opens a tag the attribute parser understood (no half-open tag smuggled through).
	expect(html.match(/</g)?.length ?? 0).toBe(
		html.match(/<\/?[a-z][a-z0-9]*(?:\s+[a-z-]+(?:="[^"]*")?)*\s*\/?>/gi)?.length ?? 0
	);
	for (const url of urls(html)) {
		expect(url).not.toMatch(/^\s*(javascript|vbscript|data|file):/i);
		expect(isSafeUrl(url)).toBe(true);
	}
}

describe('renderMarkdown: ordinary Markdown', () => {
	it('renders headings, lists, emphasis, code and tables', () => {
		const html = renderMarkdown(
			'# Title\n\n- **one**\n- `two`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```'
		);
		expect(html).toContain('<h1>Title</h1>');
		expect(html).toContain('<strong>one</strong>');
		expect(html).toContain('<code>two</code>');
		expect(html).toContain('<table>');
		expect(html).toContain('<pre><code>code\n</code></pre>');
	});

	it('keeps relative, https and mailto links; external ones get rel=noopener noreferrer nofollow', () => {
		const html = renderMarkdown(
			'[kb](/kb/onboarding) [sec](#setup) [rel](./other) [ext](https://example.com/a) [mail](mailto:team@example.test)'
		);
		expect(html).toContain('<a href="/kb/onboarding">kb</a>');
		expect(html).toContain('<a href="#setup">sec</a>');
		expect(html).toContain('<a href="./other">rel</a>');
		expect(html).toContain(
			'<a href="https://example.com/a" rel="noopener noreferrer nofollow">ext</a>'
		);
		expect(html).toContain('<a href="mailto:team@example.test">mail</a>');
	});

	it('linkifies bare URLs, with the external rel', () => {
		const html = renderMarkdown('See https://example.com/docs and mail team@example.test.');
		expect(html).toContain(
			'<a href="https://example.com/docs" rel="noopener noreferrer nofollow">'
		);
		expect(html).toContain('<a href="mailto:team@example.test">team@example.test</a>');
	});

	it('is empty for empty input', () => {
		expect(renderMarkdown('')).toBe('');
	});
});

describe('renderMarkdown: XSS vectors stay inert', () => {
	it.each([
		['script tag', '<script>alert(1)</script>'],
		['script tag mixed case', '<ScRiPt src=//evil.test/x.js></sCrIpT>'],
		['img onerror', '<img src=x onerror=alert(1)>'],
		['svg onload', '<svg onload=alert(1)>'],
		['iframe', '<iframe src="javascript:alert(1)"></iframe>'],
		['inline event in a block', '<div onmouseover="alert(1)">hover</div>'],
		['style tag', '<style>body{display:none}</style>'],
		['html comment trick', '<!--><script>alert(1)</script>-->'],
		['javascript link', '[x](javascript:alert(1))'],
		['javascript link upper case', '[x](JAVASCRIPT:alert(1))'],
		['javascript link mixed case', '[x](JaVaScRiPt:alert(1))'],
		['entity-encoded j', '[x](&#106;avascript:alert(1))'],
		['hex entity colon', '[x](javascript&#x3A;alert(1))'],
		['named entity colon', '[x](javascript&colon;alert(1))'],
		['tab inside scheme', '[x](java&#x09;script:alert(1))'],
		['newline entity inside scheme', '[x](java&#10;script:alert(1))'],
		['leading space', '[x]( javascript:alert(1))'],
		['angle-bracket destination', '[x](<javascript:alert(1)>)'],
		['percent-encoded scheme', '[x](java%09script:alert(1))'],
		['backslash escape', '[x](javascript\\:alert(1))'],
		['vbscript link', '[x](vbscript:msgbox(1))'],
		['file link', '[x](file:///etc/passwd)'],
		['data html link', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
		['data image', '![x](data:image/png;base64,iVBORw0KGgo=)'],
		['data svg image', '![x](data:image/svg+xml,<svg onload=alert(1)>)'],
		['javascript image', '![x](javascript:alert(1))'],
		['reference-style link', '[x][r]\n\n[r]: javascript:alert(1)'],
		['autolink', '<javascript:alert(1)>'],
		['linkify javascript', 'javascript:alert(1)'],
		['protocol-relative', '[x](//evil.test/phish)'],
		['backslash host', '[x](/\\evil.test)'],
		['title attribute breakout', '[x](/a "t\\" onmouseover=\\"alert(1)")'],
		['alt attribute breakout', '![x" onerror="alert(1)](/a.png)'],
		['mention name with html', `@[<img src=x onerror=alert(1)>](user:${ID})`],
		['mention name with quote', `@["onmouseover="alert(1)](user:${ID})`],
		['unknown scheme', '[x](chrome://settings)']
	])('%s', (_, source) => {
		const html = renderMarkdown(source);
		assertInert(html);
	});

	it('escapes raw HTML as text', () => {
		expect(renderMarkdown('<script>alert(1)</script>')).toContain(
			'&lt;script&gt;alert(1)&lt;/script&gt;'
		);
		expect(renderMarkdown('<img src=x onerror=alert(1)>')).toContain(
			'&lt;img src=x onerror=alert(1)&gt;'
		);
	});

	it('turns a refused link into text, never an empty-href anchor', () => {
		const html = renderMarkdown('[click](javascript:alert(1))');
		expect(html).not.toContain('<a');
		expect(html).toContain('[click](javascript:alert(1))');
	});

	it('keeps an http image (the CSP decides whether it loads) and refuses data: images', () => {
		expect(renderMarkdown('![logo](/files/abc)')).toContain('<img src="/files/abc" alt="logo">');
		expect(renderMarkdown('![x](data:image/png;base64,AAAA)')).not.toContain('<img');
	});
});

describe('isSafeUrl', () => {
	it.each([
		'/a',
		'#x',
		'./a',
		'../a',
		'page',
		'https://e.test',
		'http://e.test',
		'mailto:a@b.test',
		'?q=1',
		'a/b:c'
	])('allows %s', (url) => expect(isSafeUrl(url)).toBe(true));
	it.each([
		'',
		'javascript:alert(1)',
		'JavaScript:x',
		'vbscript:x',
		'data:text/html,x',
		'file:///x',
		'java%09script:x',
		'//evil.test',
		'/\\evil.test',
		'https://e.test/a b',
		'tel:123',
		'ftp://e.test',
		'x'.repeat(3000)
	])('refuses %j', (url) => expect(isSafeUrl(url)).toBe(false));
});

describe('mentions', () => {
	it('renders a mention as a span with the escaped name', () => {
		expect(renderMarkdown(`Ping @[Dewi Lestari](user:${ID}) please`)).toBe(
			'<p>Ping <span class="mention">@Dewi Lestari</span> please</p>\n'
		);
		expect(renderMarkdown(`@[<b>x</b>](user:${ID})`)).toContain(
			'<span class="mention">@&lt;b&gt;x&lt;/b&gt;</span>'
		);
	});

	it('with names, shows the current name of the id, or "unknown user", never the typed label', () => {
		const names = new Map([[ID, 'Dewi Lestari']]);
		expect(
			renderMarkdown(`@[Someone Else](user:${ID.toUpperCase()}) and @[X](user:${ID2})`, names)
		).toBe(
			`<p><span class="mention">@Dewi Lestari</span> and <span class="mention">@${UNKNOWN_USER}</span></p>\n`
		);
		expect(renderMarkdown(`@[x](user:${ID})`, new Map([[ID, '<b>Dewi</b>']]))).toContain(
			'<span class="mention">@&lt;b&gt;Dewi&lt;/b&gt;</span>'
		);
		// A mention inside code is not a mention, with or without names.
		expect(renderMarkdown(`\`@[A](user:${ID})\``, names)).toContain(`@[A](user:${ID})`);
	});

	it('leaves a malformed mention as text (and never a user: link)', () => {
		for (const source of [
			'@[Dewi](user:not-a-uuid)',
			'[Dewi](user:' + ID + ')',
			'@[](user:' + ID + ')'
		]) {
			const html = renderMarkdown(source);
			expect(html).not.toContain('class="mention"');
			expect(html).not.toContain('href="user:');
		}
	});

	it('extracts ids in order, lower-cased, de-duplicated, outside code only', () => {
		const body =
			`@[A](user:${ID.toUpperCase()}) and @[B](user:${ID2}) and again @[A](user:${ID})\n\n` +
			`\`@[C](user:11111111-1111-4111-8111-111111111111)\`\n\n` +
			'```\n@[D](user:22222222-2222-4222-8222-222222222222)\n```';
		expect(extractMentionIds(body)).toEqual([ID, ID2]);
		expect(extractMentionIds('')).toEqual([]);
		expect(extractMentionIds('no mentions')).toEqual([]);
	});

	it('caps the ids one body yields', () => {
		const many = Array.from(
			{ length: MENTIONS_MAX + 10 },
			(_, i) => `@[U${i}](user:00000000-0000-4000-8000-${String(i).padStart(12, '0')})`
		).join(' ');
		expect(extractMentionIds(many)).toHaveLength(MENTIONS_MAX);
	});

	it('mentionMarkup writes the token the renderer reads', () => {
		const markup = mentionMarkup({ id: ID, name: 'Dewi [ops]\nLestari' });
		expect(markup).toBe(`@[Dewi opsLestari](user:${ID})`);
		expect(extractMentionIds(markup)).toEqual([ID]);
	});
});
