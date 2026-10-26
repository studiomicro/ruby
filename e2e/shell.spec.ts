import { expect, test, type Locator } from '@playwright/test';
import { emulateSafeAreas, expectNoHorizontalOverflow } from './helpers';

/**
 * The app shell at iPhone 17 / 17 Pro / 18 Pro (402 × 874), Pro Max (440 × 956), 360 px and desktop (1280 × 800):
 * no sideways scroll, the phone tab bar never covers content, the desktop sidebar, and the bars following the safe
 * areas (emulated through the --sai-* variables).
 */

const isPhone = (width: number) => width < 768;
const box = async (locator: Locator) => {
	const b = await locator.boundingBox();
	if (!b) throw new Error('element has no box');
	return b;
};

test.describe('signed out', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('the login page renders without horizontal overflow', async ({ page }) => {
		await page.goto('/login');
		await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
		await expect(page.getByLabel('E-mail')).toBeVisible();
		await expectNoHorizontalOverflow(page);
		// iOS zooms into fields under 16 px: every field is at least 16 px.
		const size = await page
			.getByLabel('E-mail')
			.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
		expect(size).toBeGreaterThanOrEqual(16);
	});
});

test.describe('signed in', () => {
	test('home renders; tab bar on phones, sidebar on desktop', async ({ page, viewport }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { level: 1, name: /Welcome/ })).toBeVisible();
		await expectNoHorizontalOverflow(page);
		const tabbar = page.locator('nav.tabbar');
		const sidebar = page.locator('aside.sidebar');
		if (isPhone(viewport!.width)) {
			await expect(tabbar).toBeVisible();
			await expect(sidebar).toBeHidden();
			for (const name of ['Home', 'My tasks', 'Projects', 'KB', 'More'])
				await expect(tabbar.getByText(name, { exact: true })).toBeVisible();
			// Every tab is a 44 px target at least.
			for (const tab of await tabbar.locator('.tab').all())
				expect((await box(tab)).height).toBeGreaterThanOrEqual(44);
			// Scrolled to the very end, the last piece of content still ends above the tab bar.
			await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
			const last = page.locator('main > *').last();
			const lastBox = await box(last);
			const barBox = await box(tabbar);
			expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(barBox.y);
			expect(barBox.y + barBox.height).toBeCloseTo(viewport!.height, 0);
		} else {
			await expect(sidebar).toBeVisible();
			await expect(tabbar).toBeHidden();
			await expect(sidebar.getByRole('link', { name: 'Knowledge base' })).toBeVisible();
			await expect(sidebar.getByRole('link', { name: 'Admin', exact: true })).toBeVisible();
			await expect(sidebar.getByRole('link', { name: 'Home' })).toHaveAttribute(
				'aria-current',
				'page'
			);
		}
	});

	test('the More sheet opens above the tab bar with the other destinations', async ({
		page,
		viewport
	}) => {
		test.skip(!isPhone(viewport!.width), 'phone only');
		await page.goto('/');
		await page.locator('nav.tabbar summary').click();
		const sheet = page.locator('nav.tabbar .sheet');
		await expect(sheet).toBeVisible();
		// The sheet is a <details>, so it opens before hydration; Escape and the backdrop need the hydrated shell. Under
		// load the page can still be hydrating here: wait for the backdrop (rendered only by the hydrated shell).
		await expect(page.locator('button.backdrop')).toBeVisible();
		for (const name of ['Search', 'Notifications', 'Admin', 'Account', 'Sign out'])
			await expect(sheet.getByText(name, { exact: true })).toBeVisible();
		const sheetBox = await box(sheet);
		const barBox = await box(page.locator('nav.tabbar'));
		expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(barBox.y);
		await expectNoHorizontalOverflow(page);
		await page.keyboard.press('Escape');
		await expect(sheet).toBeHidden();
	});

	test('the bars move with the safe areas (Dynamic Island, home indicator, landscape)', async ({
		page,
		viewport
	}) => {
		test.skip(!isPhone(viewport!.width), 'phone only');
		await page.goto('/account');
		const brand = page.locator('header.topbar .brand');
		const tabbar = page.locator('nav.tabbar');
		const firstTab = tabbar.locator('.tab').first();
		const before = { brand: await box(brand), tab: await box(firstTab) };

		await emulateSafeAreas(page, { top: 59, bottom: 34 });
		const after = { brand: await box(brand), tab: await box(firstTab) };
		expect(after.brand.y).toBeGreaterThanOrEqual(59);
		expect(after.brand.y - before.brand.y).toBeCloseTo(59, 0);
		// The tabs rise above the home indicator; the bar itself still reaches the bottom edge.
		expect(after.tab.y + after.tab.height).toBeLessThanOrEqual(viewport!.height - 34 + 0.5);
		const bar = await box(tabbar);
		expect(bar.y + bar.height).toBeCloseTo(viewport!.height, 0);
		// Content still ends above the (now taller) tab bar.
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		const last = await box(page.locator('main > *').last());
		expect(last.y + last.height).toBeLessThanOrEqual((await box(tabbar)).y);

		// Landscape notch: content and bars keep clear of the left and right insets.
		await emulateSafeAreas(page, { left: 47, right: 47 });
		const heading = await box(page.getByRole('heading', { level: 1, name: 'Account' }));
		expect(heading.x).toBeGreaterThanOrEqual(47);
		expect((await box(brand)).x).toBeGreaterThanOrEqual(47);
		const lastTab = await box(tabbar.locator('.tab').last());
		expect(lastTab.x + lastTab.width).toBeLessThanOrEqual(viewport!.width - 47 + 0.5);
		await expectNoHorizontalOverflow(page);
	});

	test('the admin users page fits the screen', async ({ page }) => {
		await page.goto('/admin/users');
		await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
		await expect(
			page.locator('main').getByText('Ada Admin', { exact: false }).first()
		).toBeVisible();
		await expectNoHorizontalOverflow(page);
	});
});
