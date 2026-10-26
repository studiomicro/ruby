import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tailwind v4 generates a utility for every class name it finds in the source, so a component's own class that happens
 * to be a utility name gets the utility's rule too: `<table class="grid">` became `display: grid` and broke the team
 * calendar; `class="outline"` drew a solid outline. These names are reserved for Tailwind and never used as a
 * component's own class; `grid` and `flex` are allowed on block containers, never on table parts.
 */
const RESERVED = [
	'outline',
	'table',
	'ring',
	'shadow',
	'border',
	'rounded',
	'truncate',
	'transform',
	'filter',
	'container',
	'collapse',
	'invisible',
	'visible'
];
const TABLE_PARTS = /<(table|thead|tbody|tfoot|tr|td|th)\b[^>]*\bclass="([^"]*)"/g;

function svelteFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return svelteFiles(path);
		return path.endsWith('.svelte') ? [path] : [];
	});
}

describe('component classes never collide with Tailwind utilities', () => {
	const files = svelteFiles('src');

	it('uses no reserved utility name as a class', () => {
		const hits: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, 'utf8');
			for (const match of source.matchAll(/\bclass="([^"]*)"/g))
				for (const token of (match[1] ?? '').split(/\s+/))
					if (RESERVED.includes(token)) hits.push(`${file}: ${token}`);
		}
		expect(hits).toEqual([]);
	});

	it('never puts a display utility (grid, flex) on a table part', () => {
		const hits: string[] = [];
		for (const file of files)
			for (const match of readFileSync(file, 'utf8').matchAll(TABLE_PARTS))
				for (const token of (match[2] ?? '').split(/\s+/))
					if (token === 'grid' || token === 'flex' || token === 'block')
						hits.push(`${file}: <${match[1]} class="${token}">`);
		expect(hits).toEqual([]);
	});
});
