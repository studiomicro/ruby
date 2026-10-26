import { describe, expect, it } from 'vitest';
import {
	buildMatchQuery,
	normaliseQuery,
	parseSearchType,
	parseTaskRef,
	queryTokens,
	splitMarkedSnippet
} from './query';

describe('buildMatchQuery', () => {
	it.each([
		['foo bar', '"foo"* "bar"*'],
		['  Foo   BAR ', '"foo"* "bar"*'],
		['"', null],
		['*', null],
		['', null],
		['   ', null],
		['!!! ??? ...', null],
		['😀😀', null],
		['AND OR NOT', '"and"* "or"* "not"*'],
		['a:b', '"a" "b"'],
		['title:secret', '"title"* "secret"*'],
		['NEAR(a b)', '"near"* "a" "b"'],
		['(', null],
		['-x', '"x"'],
		['^x', '"x"'],
		['x*', '"x"'],
		['xy*', '"xy"*'],
		['"a" OR "b"', '"a" "or"* "b"'],
		['{title body}: x', '"title"* "body"* "x"'],
		["o'reilly", '"o" "reilly"*'],
		['😀 a 日', '"a" "日"'],
		['café', '"café"*'],
		['日本語 テキスト', '"日本語"* "テキスト"*'],
		['ＡＢＣ１２３', '"abc123"*']
	])('%j → %j', (input, expected) => {
		expect(buildMatchQuery(input)).toBe(expected);
	});

	it('never lets a quote, operator or column filter outside a quoted token', () => {
		const hostile = '" OR 1=1 -- NEAR/3 col:val ^start (x) "unbalanced * + {a b}';
		const m = buildMatchQuery(hostile) ?? '';
		expect(m).toMatch(/^("[\p{L}\p{N}]+"\*?)( "[\p{L}\p{N}]+"\*?)*$/u);
	});

	it('keeps at most 8 tokens and drops tokens over 64 characters', () => {
		expect(queryTokens('a b c d e f g h i j')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
		expect(queryTokens(`${'x'.repeat(65)} ok ${'y'.repeat(64)}`)).toEqual(['ok', 'y'.repeat(64)]);
	});

	it('cuts input at 200 characters instead of refusing it', () => {
		const long = 'word '.repeat(2000);
		expect(normaliseQuery(long).length).toBeLessThanOrEqual(200);
		expect(buildMatchQuery('x'.repeat(10_000))).toBeNull();
		expect(buildMatchQuery('ab '.repeat(5000))).toBe(Array(8).fill('"ab"*').join(' '));
	});
});

describe('splitMarkedSnippet', () => {
	it('splits at the markers', () => {
		expect(splitMarkedSnippet('a \u0001hit\u0002 b')).toEqual([
			{ text: 'a ', hit: false },
			{ text: 'hit', hit: true },
			{ text: ' b', hit: false }
		]);
	});
	it('handles stray, unbalanced and adjacent markers without leaking them', () => {
		expect(splitMarkedSnippet('\u0002x\u0001y')).toEqual([
			{ text: 'x', hit: false },
			{ text: 'y', hit: true }
		]);
		expect(splitMarkedSnippet('\u0001a\u0002\u0001b\u0002')).toEqual([{ text: 'ab', hit: true }]);
		expect(splitMarkedSnippet('')).toEqual([]);
		const segs = splitMarkedSnippet('<script>\u0001x\u0002</script>');
		expect(segs.map((s) => s.text).join('')).toBe('<script>x</script>');
		expect(segs.some((s) => s.text.includes('\u0001') || s.text.includes('\u0002'))).toBe(false);
	});
});

describe('task refs and type', () => {
	it('parses identifiers', () => {
		expect(parseTaskRef('OPS-12')).toEqual({ key: 'OPS', number: 12 });
		expect(parseTaskRef('ops-1')).toEqual({ key: 'OPS', number: 1 });
		for (const bad of ['OPS-0', 'OPS12', 'O-1', 'OPS-12 x', '1A-2'])
			expect(parseTaskRef(bad)).toBeNull();
	});
	it('falls back to all', () => {
		expect(parseSearchType('pages')).toBe('pages');
		expect(parseSearchType('tasks')).toBe('tasks');
		expect(parseSearchType('users')).toBe('all');
		expect(parseSearchType(null)).toBe('all');
	});
});
