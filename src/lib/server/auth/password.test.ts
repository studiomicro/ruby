import { pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	checkPasswordStrength,
	derive,
	equalConstantTime,
	isPlausibleEmail,
	normalizeEmail,
	PASSWORD_ERRORS,
	PASSWORD_MIN_LENGTH,
	PBKDF2_ITERATIONS,
	PBKDF2_MAX_ITERATIONS
} from './password';

describe('PBKDF2 iteration count', () => {
	it('stays within the Workers cap', () => {
		expect(PBKDF2_MAX_ITERATIONS).toBe(100_000);
		expect(PBKDF2_ITERATIONS).toBe(100_000);
		expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(PBKDF2_MAX_ITERATIONS);
	});

	it.each([PBKDF2_MAX_ITERATIONS + 1, 0, -1, 1.5, Number.NaN])(
		'derive refuses %s iterations',
		async (n) => {
			await expect(derive('blue-lantern-7', new Uint8Array(16), n)).rejects.toThrow(
				/iteration count/
			);
		}
	);

	it('derive is PBKDF2-HMAC-SHA256', async () => {
		const salt = new Uint8Array(16).fill(7);
		expect(await derive('blue-lantern-7', salt, 1000)).toBe(
			pbkdf2Sync('blue-lantern-7', salt, 1000, 32, 'sha256').toString('base64')
		);
	});
});

describe('checkPasswordStrength', () => {
	it('uses a floor of 10 characters', () => {
		expect(PASSWORD_MIN_LENGTH).toBe(10);
		expect(checkPasswordStrength('blue-lant7', 'dewi@example.test')).toBeNull();
		expect(checkPasswordStrength('blue-lant', 'dewi@example.test')).toBe('too_short');
	});
	it('refuses overlong, common, repeated and e-mail passwords', () => {
		expect(checkPasswordStrength('a'.repeat(201), 'x@y.test')).toBe('too_long');
		expect(checkPasswordStrength('Password123', 'x@y.test')).toBe('too_simple');
		expect(checkPasswordStrength('1234567890', 'x@y.test')).toBe('too_simple');
		expect(checkPasswordStrength('zzzzzzzzzzzz', 'x@y.test')).toBe('too_simple');
		expect(checkPasswordStrength('abcabcabcabc', 'x@y.test')).toBe('too_simple');
		expect(checkPasswordStrength('dewilestari', 'DewiLestari@example.test')).toBe('same_as_email');
		expect(checkPasswordStrength('dewi@example.test', 'dewi@example.test')).toBe('same_as_email');
	});
	it('has an English message for every problem', () => {
		for (const message of Object.values(PASSWORD_ERRORS)) expect(message).toMatch(/^[A-Z][^]*\.$/);
	});
});

describe('e-mail helpers', () => {
	it('normalises case and whitespace', () => {
		expect(normalizeEmail('  Dewi@Example.TEST ')).toBe('dewi@example.test');
	});
	it.each(['dewi@example.test', 'a.b+c@sub.example.co.id'])('accepts %s', (e) =>
		expect(isPlausibleEmail(e)).toBe(true)
	);
	it.each([
		'dewi',
		'dewi@example',
		'@example.test',
		'de wi@example.test',
		'a@b@c.test',
		'a\u0000@b.test'
	])('refuses %j', (e) => expect(isPlausibleEmail(e)).toBe(false));
	it.each(['a​b@example.test', 'ab@exa‍mple.test', 'a‮b@example.test', 'a b@example.test'])(
		'refuses invisible format/separator characters in %j',
		(e) => expect(isPlausibleEmail(e)).toBe(false)
	);
	it('refuses more than 254 characters', () => {
		expect(isPlausibleEmail(`${'a'.repeat(250)}@b.test`)).toBe(false);
	});
});

describe('equalConstantTime', () => {
	it('compares exactly', () => {
		expect(equalConstantTime('abc', 'abc')).toBe(true);
		expect(equalConstantTime('abc', 'abd')).toBe(false);
		expect(equalConstantTime('abc', 'abcd')).toBe(false);
	});
});
