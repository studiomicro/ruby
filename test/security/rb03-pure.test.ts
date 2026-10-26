import { describe, expect, it } from 'vitest';
import { computeRecipients } from '#lib/server/comments/recipients';
import {
	parseCommentBody,
	parseCommentId,
	parseCommentPage
} from '#lib/server/comments/validation';
import { commentExcerpt } from '#lib/server/notifications/excerpt';
import { parseCursor } from '#lib/server/notifications/repo';
import { extractMentionIds, renderMarkdown } from '#lib/shared/markdown';
import { insertMention, sanitizeMentionName } from '#lib/ui/comments/mention';

/** RB-03 red-team probes on pure code. See docs/features/rb-03-comments-notifications/SECURITY_REPORT.md. */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const names = new Map([
	[A, 'Ann Real'],
	[B, 'Ben Real']
]);

describe('comment Markdown XSS (rendered with the thread’s names)', () => {
	const vectors = [
		'<script>alert(1)</script>',
		'<img src=x onerror=alert(1)>',
		'[x](javascript:alert(1))',
		'[x](JaVaScRiPt:alert(1))',
		'[x](&#106;avascript:alert(1))',
		'[x](java%0ascript:alert(1))',
		'[x](vbscript:msgbox(1))',
		'[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
		'![i](javascript:alert(1))',
		'![i](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)',
		'[r][1]\n\n[1]: javascript:alert(1)',
		'<javascript:alert(1)>',
		`[@[Ann](user:${A})](javascript:alert(1))`,
		`@[x" onmouseover="alert(1)](user:${A})`,
		'[x](//evil.example)',
		'[x](\\\\evil.example)'
	];
	for (const v of vectors)
		it(`inert: ${JSON.stringify(v).slice(0, 60)}`, () => {
			const html = renderMarkdown(v, names);
			expect(html).not.toMatch(
				/<script|<img[^>]+onerror|onmouseover=|href="(javascript|vbscript|data):/i
			);
			expect(html).not.toMatch(/href="\/\/|src="(javascript|data):/i);
		});

	it('a mention inside link text still shows the real name, and the link itself is dropped', () => {
		const html = renderMarkdown(`[@[Boss](user:${A})](javascript:alert(1))`, names);
		expect(html).toContain('@Ann Real');
		expect(html).not.toContain('Boss');
		// The refused link stays literal text, never an href.
		expect(html).not.toContain('href');
	});
});

describe('notification excerpt', () => {
	it('mentions use the real name, never the typed label; unknown ids say "unknown user"', () => {
		expect(commentExcerpt(`@[CEO](user:${A}) approved`, names)).toBe('@Ann Real approved');
		expect(commentExcerpt(`@[CEO](user:${B.replace('2', '3')}) ok`, names)).toBe(
			'@unknown user ok'
		);
	});

	it('a mention in a code block is not a mention for notifying, and the excerpt still uses the real name', () => {
		const body = '```\n@[CEO](user:' + A + ')\n```';
		expect(extractMentionIds(body)).toEqual([]);
		expect(commentExcerpt(body, names)).not.toContain('CEO');
	});

	it('HTML stays text (the inbox renders it with {text}, never {@html}); length is capped', () => {
		const e = commentExcerpt('<img src=x onerror=alert(1)> ' + 'z'.repeat(500), names);
		expect(e.startsWith('<img src=x onerror=alert(1)>')).toBe(true);
		expect(Array.from(e).length).toBeLessThanOrEqual(141);
	});

	it('zero-width and bidi controls do not survive into the excerpt', () => {
		const e = commentExcerpt('pay\u200b\u202eto evil', names);
		expect(e).not.toMatch(/[\u200b\u202e]/);
	});
});

describe('recipients', () => {
	it('self, disabled, unknown never notified; cap 20; mention wins over comment', () => {
		const ids = Array.from(
			{ length: 30 },
			(_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
		);
		const active = new Set([...ids, A]);
		const out = computeRecipients({
			mentionIds: [A, ...ids, B],
			activeIds: active,
			assigneeId: A,
			creatorId: ids[29],
			authorId: A
		});
		expect(out.has(A)).toBe(false);
		expect(out.has(B)).toBe(false);
		expect([...out.values()].filter((k) => k === 'mention').length).toBe(20);
		expect(out.get(ids[29]!)).toBe('comment');
	});
});

describe('input parsing', () => {
	it('comment ids, pages and cursors accept only their exact shapes', () => {
		for (const bad of ["1' OR '1'='1", `${A} `, `${A}\n`, '../x', ''])
			expect(parseCommentId(bad)).toBeNull();
		expect(parseCommentPage('99999999')).toBe(1);
		expect(parseCommentPage('//evil')).toBe(1);
		expect(parseCursor(`1_${A}' --`)).toBeNull();
		expect(parseCursor('9999999999999999_' + A)).toBeNull();
	});

	it('bodies of control characters only are empty; NUL is stripped', () => {
		expect(parseCommentBody('\u0000\u0001 \n').ok).toBe(false);
		const r = parseCommentBody('a\u0000b');
		expect(r).toEqual({ ok: true, value: 'ab' });
	});
});

describe('mention picker insertion', () => {
	it('a hostile display name cannot break out of the mention token', () => {
		const name = 'Eve](user:' + A + ') [x](javascript:alert(1)';
		expect(sanitizeMentionName(name)).not.toMatch(/[[\]()]/);
		const { text } = insertMention('@ev', 0, 3, { id: B, name });
		expect(extractMentionIds(text)).toEqual([B]);
		expect(renderMarkdown(text, names)).toContain('@Ben Real');
		expect(renderMarkdown(text, names)).not.toContain('javascript');
	});
});
