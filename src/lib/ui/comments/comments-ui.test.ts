import { describe, expect, it } from 'vitest';
import { extractMentionIds } from '#lib/shared/markdown';
import { insertMention, mentionQueryAt, sanitizeMentionName } from './mention';
import { relativeTime } from './relative';

const ANN = '00000000-0000-4000-8000-000000000002';

describe('mentionQueryAt', () => {
	it('finds the @word ending at the caret', () => {
		expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
		expect(mentionQueryAt('hello @an', 9)).toEqual({ start: 6, query: 'an' });
		expect(mentionQueryAt('(@an', 4)).toEqual({ start: 1, query: 'an' });
		expect(mentionQueryAt('line\n@b', 7)).toEqual({ start: 5, query: 'b' });
	});

	it('ignores e-mail addresses, finished words and long queries', () => {
		expect(mentionQueryAt('mail ann@example.test', 21)).toBeNull();
		expect(mentionQueryAt('@ann done', 9)).toBeNull();
		expect(mentionQueryAt(`@${'a'.repeat(51)}`, 52)).toBeNull();
		expect(mentionQueryAt(`x${'a'.repeat(60)}@b`, 63)).toBeNull();
	});
});

describe('insertMention', () => {
	it('replaces the @query with the token and a space; the server parses it back', () => {
		const r = insertMention('hi @an!', 3, 6, { id: ANN, name: 'Ann Lee' });
		expect(r.text).toBe(`hi @[Ann Lee](user:${ANN}) !`);
		expect(r.caret).toBe(r.text.indexOf(' !') + 1);
		expect(extractMentionIds(r.text)).toEqual([ANN]);
	});

	it('sanitises brackets, parentheses and line breaks out of the name', () => {
		expect(sanitizeMentionName('Ann] (x)\n[y')).toBe('Ann xy');
		expect(sanitizeMentionName('[]()')).toBe('user');
		const r = insertMention('@', 0, 1, { id: ANN, name: 'A](javascript:x)' });
		expect(extractMentionIds(r.text)).toEqual([ANN]);
		expect(r.text).toBe(`@[Ajavascript:x](user:${ANN}) `);
	});
});

describe('relativeTime', () => {
	const now = Date.UTC(2026, 9, 26, 12);
	it('phrases', () => {
		expect(relativeTime(now - 10_000, now)).toBe('just now');
		expect(relativeTime(now + 60_000, now)).toBe('just now');
		expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
		expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
		expect(relativeTime(now - 26 * 3_600_000, now)).toBe('yesterday');
		expect(relativeTime(now - 5 * 86_400_000, now)).toBe('5 days ago');
		expect(relativeTime(now - 40 * 86_400_000, now)).toBeNull();
	});
});
