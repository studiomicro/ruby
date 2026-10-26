import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TAB_ITEMS } from './nav';
import { parentHref, ROUTE_PARENTS } from './route-parent';

/** Every `(app)` page route id (without the group), from the route tree. */
function appPages(dir = 'src/routes/(app)', prefix = ''): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...appPages(path, `${prefix}/${name}`));
		else if (name === '+page.svelte') out.push(prefix || '/');
	}
	return out;
}

describe('route parents (standalone back control)', () => {
	const pages = appPages();
	const tabs = new Set(TAB_ITEMS.map((item) => item.href));

	it('every (app) page but the four tab destinations has a parent; the tabs have none', () => {
		for (const page of pages)
			if (tabs.has(page)) expect(ROUTE_PARENTS[page], page).toBeUndefined();
			else expect(ROUTE_PARENTS[page], page).toBeDefined();
	});

	it('every entry is a real page and every parent is a real page', () => {
		const known = new Set(pages);
		for (const [route, parent] of Object.entries(ROUTE_PARENTS)) {
			expect(known.has(route), route).toBe(true);
			expect(known.has(parent), `${route} -> ${parent}`).toBe(true);
		}
	});

	it('fills the parameters', () => {
		expect(parentHref('/(app)/projects/[key]/tasks/[number]', { key: 'OPS', number: '7' })).toBe(
			'/projects/OPS'
		);
		expect(parentHref('/(app)/kb/[id]', { id: 'abc' })).toBe('/kb');
		expect(parentHref('/(app)/kb/[id]/history/[revision]', { id: 'a b', revision: '2' })).toBe(
			'/kb/a%20b/history'
		);
		expect(parentHref('/(app)/people', {})).toBe('/');
	});

	it('no back control on a tab destination, an unknown route or with a missing parameter', () => {
		for (const tab of tabs) expect(parentHref(`/(app)${tab === '/' ? '' : tab}`, {})).toBeNull();
		expect(parentHref(null, {})).toBeNull();
		expect(parentHref('/(app)/nowhere', {})).toBeNull();
		expect(parentHref('/(app)/kb/[id]/edit', {})).toBeNull();
	});
});
