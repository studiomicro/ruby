import { describe, expect, it } from 'vitest';
import { deleteRefusal } from './permissions';
import {
	checkBody,
	checkTitle,
	KB_LIMITS,
	parseParentId,
	parsePlacement,
	parseProjectKey,
	parseRevision,
	TITLE_REQUIRED,
	TITLE_TOO_LONG
} from './validation';

const UUID = '0b6c1a8e-58d7-4c47-9f3e-1d2a3b4c5d6e';

describe('titles', () => {
	it('accepts 1 and 200 characters, refuses 0 and 201', () => {
		expect(checkTitle('a')).toEqual({ value: 'a' });
		expect(checkTitle('a'.repeat(200)).error).toBeUndefined();
		expect(checkTitle('').error).toBe(TITLE_REQUIRED);
		expect(checkTitle('   ').error).toBe(TITLE_REQUIRED);
		expect(checkTitle('a'.repeat(201)).error).toBe(TITLE_TOO_LONG);
		expect(checkTitle('a'.repeat(10_000)).error).toBe(TITLE_TOO_LONG);
	});

	it('counts code points, so 200 emoji are allowed', () => {
		expect(checkTitle('😀'.repeat(200)).error).toBeUndefined();
		expect(checkTitle('😀'.repeat(201)).error).toBe(TITLE_TOO_LONG);
	});

	it('strips control, zero-width and bidi characters and collapses newlines', () => {
		expect(checkTitle('On​board\u0007ing').value).toBe('Onboarding');
		expect(checkTitle('‮evil‬ name').value).toBe('evil name');
		expect(checkTitle('Line one\r\n\tline two').value).toBe('Line one line two');
		expect(checkTitle('​‍').error).toBe(TITLE_REQUIRED);
	});
});

describe('bodies', () => {
	it('accepts 200,000 characters and refuses 200,001', () => {
		expect(checkBody('a'.repeat(KB_LIMITS.bodyMax)).error).toBeUndefined();
		expect(checkBody('a'.repeat(KB_LIMITS.bodyMax + 1)).error).toBeTruthy();
		expect(checkBody('').error).toBeUndefined();
	});

	it('counts code points like the title: 200,000 emoji are allowed, 200,001 are not', () => {
		expect(checkBody('😀'.repeat(KB_LIMITS.bodyMax)).error).toBeUndefined();
		expect(checkBody('😀'.repeat(KB_LIMITS.bodyMax + 1)).error).toBeTruthy();
		expect(checkBody('😀'.repeat(100_001)).error).toBeUndefined();
	});

	it('strips NUL and the snippet markers and normalises line ends', () => {
		expect(checkBody('a\u0000b\u0001c\u0002d').value).toBe('abcd');
		expect(checkBody('one\r\ntwo\rthree\n').value).toBe('one\ntwo\nthree\n');
		expect(checkBody('  keeps  spacing\t').value).toBe('  keeps  spacing\t');
	});
});

describe('ids, numbers and placement', () => {
	it('parses revision numbers strictly', () => {
		expect(parseRevision('1')).toBe(1);
		expect(parseRevision('999999999')).toBe(999999999);
		for (const bad of [
			'0',
			'01',
			'-1',
			'abc',
			'1e3',
			'1.5',
			' 1',
			'1234567890',
			'',
			null,
			undefined
		])
			expect(parseRevision(bad), String(bad)).toBeNull();
	});

	it('parses project keys and upper-cases them', () => {
		expect(parseProjectKey('ops')).toBe('OPS');
		expect(parseProjectKey('Web2')).toBe('WEB2');
		for (const bad of ['', 'O', '1AB', 'A-B', 'ABCDEFGHIJK', "O'R"])
			expect(parseProjectKey(bad)).toBeNull();
	});

	it('parses placement and parent fields', () => {
		expect(parsePlacement('')).toEqual({ kind: 'last' });
		expect(parsePlacement('last')).toEqual({ kind: 'last' });
		expect(parsePlacement('first')).toEqual({ kind: 'first' });
		expect(parsePlacement(`after:${UUID.toUpperCase()}`)).toEqual({
			kind: 'after',
			siblingId: UUID
		});
		expect(parsePlacement('after:')).toBeNull();
		expect(parsePlacement('after:x')).toBeNull();
		expect(parsePlacement('middle')).toBeNull();
		expect(parseParentId('')).toBeNull();
		expect(parseParentId(UUID)).toBe(UUID);
		expect(parseParentId('../etc')).toBeUndefined();
	});
});

describe('deleteRefusal', () => {
	it('deleteRefusal: admins always; members only for a subtree that is all theirs', () => {
		const page = { createdBy: 'u1' };
		expect(deleteRefusal({ id: 'u2', role: 'admin' }, page, 5)).toBeNull();
		expect(deleteRefusal({ id: 'u1', role: 'member' }, page, 0)).toBeNull();
		expect(deleteRefusal({ id: 'u1', role: 'member' }, page, 1)).toBe('others-in-subtree');
		expect(deleteRefusal({ id: 'u2', role: 'member' }, page, 0)).toBe('not-creator');
	});
});
