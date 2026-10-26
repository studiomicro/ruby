import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** SPDX ids a production dependency may carry: permissive and compatible with shipping Ruby under MIT. */
const ALLOWED = new Set([
	'MIT',
	'MIT-0',
	'ISC',
	'Apache-2.0',
	'BSD-2-Clause',
	'BSD-3-Clause',
	'0BSD',
	'BlueOak-1.0.0',
	'Python-2.0',
	'PSF-2.0',
	'OFL-1.1',
	'Unlicense',
	'CC0-1.0'
]);

type Pkg = {
	name: string;
	license?: string | { type?: string };
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
};

function load(name: string, from: string): { dir: string; pkg: Pkg } | null {
	// Node resolution: node_modules next to the requiring package, then each parent directory.
	for (let dir = from; ; dir = join(dir, '..')) {
		const candidate = join(dir, 'node_modules', name);
		if (existsSync(join(candidate, 'package.json')))
			return {
				dir: candidate,
				pkg: JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'))
			};
		if (dir === '/' || dir === join(dir, '..')) return null;
	}
}

/** Every `a OR b` choice needs one allowed id; `a AND b` needs all. */
export function licenceAllowed(expression: string): boolean {
	const ids = expression.replace(/[()]/g, ' ').trim();
	return ids
		.split(/\s+OR\s+/)
		.some((alt) => alt.split(/\s+AND\s+/).every((id) => ALLOWED.has(id.trim())));
}

describe('licenceAllowed', () => {
	it('accepts permissive ids and any permissive choice of an OR', () => {
		expect(licenceAllowed('MIT')).toBe(true);
		expect(licenceAllowed('(MIT OR GPL-3.0-only)')).toBe(true);
		expect(licenceAllowed('MIT AND ISC')).toBe(true);
	});
	it('rejects copyleft, unknown and missing licences', () => {
		expect(licenceAllowed('GPL-3.0-only')).toBe(false);
		expect(licenceAllowed('AGPL-3.0-or-later')).toBe(false);
		expect(licenceAllowed('MIT AND GPL-2.0-only')).toBe(false);
		expect(licenceAllowed('UNLICENSED')).toBe(false);
		expect(licenceAllowed('')).toBe(false);
	});
});

describe('production dependency licences', () => {
	it('are all permissive (MIT, ISC, Apache-2.0, BSD, PSF, OFL compatible)', () => {
		const root = JSON.parse(readFileSync('package.json', 'utf8')) as Pkg;
		expect(root.license).toBe('MIT');
		const seen = new Map<string, string>();
		const queue = Object.keys(root.dependencies ?? {}).map((name) => ({
			name,
			from: process.cwd()
		}));
		while (queue.length > 0) {
			const { name, from } = queue.pop()!;
			const found = load(name, from);
			if (!found) {
				// Optional dependencies of other platforms are legitimately absent.
				continue;
			}
			if (seen.has(found.dir)) continue;
			const { pkg } = found;
			seen.set(
				found.dir,
				`${pkg.name}: ${typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? '')}`
			);
			for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }))
				queue.push({ name: dep, from: found.dir });
		}
		expect(seen.size).toBeGreaterThan(3);
		const bad = [...seen.values()].filter(
			(line) => !licenceAllowed(line.slice(line.indexOf(': ') + 2))
		);
		expect(bad).toEqual([]);
	});
});
