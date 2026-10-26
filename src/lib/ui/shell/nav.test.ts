import { describe, expect, it } from 'vitest';
import {
	APP_ACTIONS,
	FOOTER_ITEMS,
	moreItems,
	moreSheetEntries,
	NAV_SECTIONS,
	TAB_ITEMS,
	visibleTo
} from './nav';

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

	it('admin-only items are hidden from members', () => {
		expect(moreItems(false).map((i) => i.href)).not.toContain('/admin');
		expect(FOOTER_ITEMS.filter(visibleTo(false)).map((i) => i.href)).toEqual(['/releases']);
	});

	it('RB-20: the More sheet lists Install Ruby and Refresh right above "What\'s new"', () => {
		for (const isAdmin of [true, false]) {
			const entries = moreSheetEntries(isAdmin);
			const labels = entries.map((e) => (e.kind === 'link' ? e.item.label : e.action.label));
			const at = labels.indexOf("What's new");
			expect(labels.slice(at - 2, at)).toEqual(['Install Ruby', 'Refresh']);
			// Every link moreItems lists is still there, in its order.
			expect(entries.flatMap((e) => (e.kind === 'link' ? [e.item.href] : []))).toEqual(
				moreItems(isAdmin).map((i) => i.href)
			);
		}
		expect(APP_ACTIONS.map((a) => a.id)).toEqual(['install', 'refresh']);
	});
});
