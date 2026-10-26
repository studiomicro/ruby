import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers';

test('QA: banner vs More sheet, signed-out, storage blocked', async ({ page, viewport }) => {
	await page.route('**/_app/version.json', (r) =>
		r.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ version: 'newer' })
		})
	);
	await page.goto('/');
	await expect(async () => {
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(page.locator('.update')).toBeVisible({ timeout: 1000 });
	}).toPass({ timeout: 15_000 });
	if (viewport!.width < 768) {
		await page.locator('nav.tabbar summary').click();
		await expect(page.locator('nav.tabbar .sheet')).toBeVisible();
		const sheet = (await page.locator('nav.tabbar .sheet').boundingBox())!;
		const ban = (await page.locator('.update').boundingBox())!;
		const overlap = !(ban.y + ban.height <= sheet.y || sheet.y + sheet.height <= ban.y);
		console.log('QA overlap', viewport!.width, overlap, JSON.stringify({ sheet, ban }));
		// what is on top at the banner centre?
		const top = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, {
			x: ban.x + ban.width / 2,
			y: ban.y + ban.height / 2
		});
		console.log('QA topmost at banner centre', viewport!.width, top);
		const sheetLinks = await page.locator('.sheet a, .sheet button').all();
		for (const l of sheetLinks) {
			const b = (await l.boundingBox())!;
			const hit = await page.evaluate(
				({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.update'),
				{ x: b.x + b.width / 2, y: b.y + b.height / 2 }
			);
			expect(hit, 'banner covers a sheet control').toBe(false);
		}
	}
	await expectNoHorizontalOverflow(page);
});

test('QA: /releases signed out', async ({ playwright }) => {
	const ctx = await playwright.request.newContext({
		baseURL: process.env.RUBY_E2E_BASE ?? `http://localhost:${process.env.RUBY_E2E_PORT}`,
		storageState: { cookies: [], origins: [] }
	});
	const r = await ctx.get('/releases', { maxRedirects: 0 });
	console.log('QA signed-out /releases', r.status(), r.headers()['location']);
	expect([302, 303, 401, 403]).toContain(r.status());
});

test('QA: localStorage throwing does not break /releases', async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, 'localStorage', {
			get() {
				throw new Error('blocked');
			}
		});
	});
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto('/releases');
	await expect(page.getByRole('heading', { level: 1, name: "What's new" })).toBeVisible();
	expect(errors).toEqual([]);
});
