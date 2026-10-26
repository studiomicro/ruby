import { describe, expect, it } from 'vitest';
import { FOOTER_ITEMS, moreItems, NAV_SECTIONS, REPORT_ISSUE, TAB_ITEMS, visibleTo } from './nav';

describe('navigation config', () => {
	it('every destination appears once in the sidebar sections', () => {
		const hrefs = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
		expect(new Set(hrefs).size).toBe(hrefs.length);
	});

	it('the tab bar shows four sidebar destinations; More lists the rest plus the utilities', () => {
		expect(TAB_ITEMS).toHaveLength(4);
		const more = moreItems(true).map((i) => i.href);
		for (const tab of TAB_ITEMS) expect(more).not.toContain(tab.href);
		for (const href of ['/people', '/search', '/notifications', '/releases', '/admin', '/account'])
			expect(more).toContain(href);
	});

	it('RB-12: Issues is item 3 of the daily-work group, not a tab, first destination under More after Report', () => {
		expect(NAV_SECTIONS.map((s) => s.items.length)).toEqual([6, 2]);
		expect(NAV_SECTIONS[0]!.items.map((i) => i.href)).toEqual([
			'/',
			'/my-tasks',
			'/issues',
			'/projects',
			'/calendar',
			'/kb'
		]);
		expect(TAB_ITEMS.map((i) => i.href)).not.toContain('/issues');
		const more = moreItems(false).map((i) => i.href);
		expect(more.slice(0, 2)).toEqual([REPORT_ISSUE.href, '/issues']);
		expect(REPORT_ISSUE).toMatchObject({ href: '/issues/new', label: 'Report an issue' });
		const all = [...NAV_SECTIONS.flatMap((s) => s.items), REPORT_ISSUE].map((i) => i.href);
		expect(new Set(all).size).toBe(all.length);
		expect(new Set(more).size).toBe(more.length);
	});

	it('admin-only items are hidden from members', () => {
		expect(moreItems(false).map((i) => i.href)).not.toContain('/admin');
		expect(FOOTER_ITEMS.filter(visibleTo(false)).map((i) => i.href)).toEqual(['/releases']);
	});
});
