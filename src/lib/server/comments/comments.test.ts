import { describe, expect, it } from 'vitest';
import { computeRecipients } from './recipients';
import { COMMENT_MESSAGES, parseCommentBody, parseCommentId, parseCommentPage } from './validation';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUTHOR = id(1);
const ANN = id(2);
const BEN = id(3);
const CAL = id(4);
const DISABLED = id(5);

describe('computeRecipients', () => {
	const active = new Set([AUTHOR, ANN, BEN, CAL]);

	it('mentioned active users get one mention each, in order; the author never', () => {
		const r = computeRecipients({
			mentionIds: [ANN, AUTHOR, ANN, BEN],
			activeIds: active,
			authorId: AUTHOR
		});
		expect([...r]).toEqual([
			[ANN, 'mention'],
			[BEN, 'mention']
		]);
	});

	it('disabled and unknown ids are ignored', () => {
		const r = computeRecipients({
			mentionIds: [DISABLED, id(99), CAL],
			activeIds: active,
			authorId: AUTHOR
		});
		expect([...r]).toEqual([[CAL, 'mention']]);
	});

	it('task assignee and creator get comment; a mention wins; one row per user', () => {
		const r = computeRecipients({
			mentionIds: [ANN],
			activeIds: active,
			assigneeId: ANN,
			creatorId: BEN,
			authorId: AUTHOR
		});
		expect([...r]).toEqual([
			[ANN, 'mention'],
			[BEN, 'comment']
		]);
		const same = computeRecipients({
			mentionIds: [],
			activeIds: active,
			assigneeId: BEN,
			creatorId: BEN,
			authorId: AUTHOR
		});
		expect([...same]).toEqual([[BEN, 'comment']]);
	});

	it('the author as assignee or creator, and a disabled assignee, get nothing', () => {
		const r = computeRecipients({
			mentionIds: [],
			activeIds: active,
			assigneeId: DISABLED,
			creatorId: AUTHOR,
			authorId: AUTHOR
		});
		expect(r.size).toBe(0);
	});

	it('caps mentions at 20 distinct notified users (the author and inactive ids do not use the cap)', () => {
		const many = Array.from({ length: 30 }, (_, i) => id(100 + i));
		const r = computeRecipients({
			mentionIds: [AUTHOR, DISABLED, ...many],
			activeIds: new Set([AUTHOR, CAL, ...many]),
			assigneeId: CAL,
			authorId: AUTHOR
		});
		expect([...r.values()].filter((k) => k === 'mention')).toHaveLength(20);
		expect([...r.keys()].slice(0, 20)).toEqual(many.slice(0, 20));
		// The assignee still hears of the comment past the mention cap.
		expect(r.get(CAL)).toBe('comment');
	});

	it('an edit notifies only users the old body did not mention', () => {
		const r = computeRecipients({
			mentionIds: [ANN, BEN],
			activeIds: active,
			authorId: AUTHOR,
			alreadyNotified: new Set([ANN])
		});
		expect([...r]).toEqual([[BEN, 'mention']]);
	});

	it('compares ids case-insensitively', () => {
		const r = computeRecipients({
			mentionIds: [ANN.toUpperCase()],
			activeIds: active,
			authorId: AUTHOR
		});
		expect([...r]).toEqual([[ANN, 'mention']]);
	});
});

describe('parseCommentBody', () => {
	it('refuses empty, whitespace-only and control-only bodies', () => {
		for (const raw of ['', '   ', '\n\t\n', '\u0000\u0001'])
			expect(parseCommentBody(raw)).toEqual({ ok: false, error: COMMENT_MESSAGES.empty });
	});

	it('accepts 1 and 10 000 characters, refuses 10 001 (code points: an emoji is one)', () => {
		expect(parseCommentBody('x')).toEqual({ ok: true, value: 'x' });
		expect(parseCommentBody('a'.repeat(10_000))).toMatchObject({ ok: true });
		expect(parseCommentBody('😀'.repeat(10_000))).toMatchObject({ ok: true });
		expect(parseCommentBody('a'.repeat(10_001))).toEqual({
			ok: false,
			error: COMMENT_MESSAGES.tooLong
		});
	});

	it('strips NUL, normalises CRLF and trims', () => {
		expect(parseCommentBody('  a\u0000b\r\nc  ')).toEqual({ ok: true, value: 'ab\nc' });
	});

	it('a body padded with control characters is cleaned whole or refused, never cut (red team info)', () => {
		// Within the raw cap: every control character goes, the text on both sides of them stays.
		expect(parseCommentBody(`start${'\u0001'.repeat(30_000)}end`)).toEqual({
			ok: true,
			value: 'startend'
		});
		// Past it: refused, not stored as "start" (the old code cut the raw text first, then cleaned).
		expect(parseCommentBody(`start${'\u0001'.repeat(45_000)}end`)).toEqual({
			ok: false,
			error: COMMENT_MESSAGES.tooLong
		});
	});

	it('a huge body is refused without cleaning all of it', () => {
		expect(parseCommentBody('a'.repeat(1_000_000))).toMatchObject({ ok: false });
	});
});

describe('ids and pages', () => {
	it('comment ids are uuids, lower-cased', () => {
		expect(parseCommentId(ANN.toUpperCase())).toBe(ANN);
		expect(parseCommentId('x')).toBeNull();
		expect(parseCommentId(`${ANN} `)).toBeNull();
	});
	it('?cpage= is a positive number, else 1', () => {
		expect(parseCommentPage('3')).toBe(3);
		for (const raw of [null, '', '0', '-1', '1e3', 'abc', '999999'])
			expect(parseCommentPage(raw)).toBe(1);
	});
});

describe('comment bodies render inert (one renderer, names from the server)', () => {
	it('script, raw HTML and javascript: links stay text; a mention shows the real name', async () => {
		const { renderMarkdown } = await import('#lib/shared/markdown');
		const html = renderMarkdown(
			`<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](JaVaScRiPt:alert(1)) @[Boss](user:${ANN})`,
			new Map([[ANN, 'Ann Real']])
		);
		expect(html).not.toMatch(/<script|<img|href="javascript/i);
		expect(html).toContain('<span class="mention">@Ann Real</span>');
	});
});
