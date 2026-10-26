import { describe, expect, it } from 'vitest';
import { commentExcerpt, EXCERPT_MAX } from './excerpt';
import { formatCursor, parseCursor, parseFilter } from './repo';

const ANN = '00000000-0000-4000-8000-000000000002';

describe('commentExcerpt', () => {
	it('shows the mentioned user’s current name, never the typed label', () => {
		const names = new Map([[ANN, 'Ann Real']]);
		expect(commentExcerpt(`Hi @[Admin Boss](user:${ANN}) look`, names)).toBe('Hi @Ann Real look');
		expect(commentExcerpt(`Hi @[Ghost](user:${ANN.replace('2', '9')})`, names)).toBe(
			'Hi @unknown user'
		);
	});

	it('keeps link and image text, drops Markdown marks and collapses whitespace', () => {
		expect(
			commentExcerpt(
				'# Title\n\n> quoted **bold** _it_ `code`\n- item [link](https://example.test) ![alt](/x.png)\n```js\nx\n```',
				new Map()
			)
		).toBe('Title quoted bold _it_ code item link alt x');
	});

	it('strips control and zero-width characters (plain text out)', () => {
		expect(commentExcerpt('a​b\u0007c <script>', new Map())).toBe('abc <script>');
	});

	it('cuts at 140 characters with an ellipsis', () => {
		const out = commentExcerpt('word '.repeat(100), new Map());
		expect(Array.from(out).length).toBeLessThanOrEqual(EXCERPT_MAX + 1);
		expect(out.endsWith('…')).toBe(true);
		expect(commentExcerpt('short', new Map())).toBe('short');
	});
});

describe('cursor and filter', () => {
	it('round-trips a cursor; malformed ones are null', () => {
		const c = { createdAt: 1_790_000_000_000, id: ANN };
		expect(parseCursor(formatCursor(c))).toEqual(c);
		expect(parseCursor(`${c.createdAt}_${ANN.toUpperCase()}`)).toEqual(c);
		for (const raw of [null, '', 'x', `abc_${ANN}`, `1_${ANN}x`, `${'9'.repeat(16)}_${ANN}`, '1_'])
			expect(parseCursor(raw)).toBeNull();
	});
	it('filter is unread or all', () => {
		expect(parseFilter('unread')).toBe('unread');
		expect(parseFilter('UNREAD')).toBe('all');
		expect(parseFilter(null)).toBe('all');
	});
});
