import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Ruby is its own project: no file names another product or its internal feature ids (owner request 2026-10-26).
 * Reads every tracked text file through `git grep`, so build output and dependencies are never scanned.
 */
// Stored encoded so this file does not itself spell the names out.
const BORROWED = [
	...['bW9udHJh', 'c2VudHJh', 'ZmluYW5jZXI='].map((b) => Buffer.from(b, 'base64').toString()),
	String.raw`\bFN-[0-9]+`
];

describe('no borrowed product names', () => {
	it('no tracked file mentions another product or its feature ids', () => {
		let out = '';
		try {
			out = execFileSync(
				'git',
				[
					'grep',
					'-n',
					'-I',
					'-i',
					'-E',
					BORROWED.join('|'),
					'--',
					'.',
					':!package-lock.json',
					':!test/no-borrowed-names.test.ts'
				],
				{ encoding: 'utf8' }
			);
		} catch (e) {
			// git grep exits 1 when nothing matches: the expected case.
			if ((e as { status?: number }).status !== 1) throw e;
		}
		expect(out.split('\n').filter(Boolean)).toEqual([]);
	});
});
