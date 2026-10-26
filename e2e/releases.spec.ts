import { readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers';

/**
 * RB-11: the /releases page, the "New" dot, and the update banner. A newer deployed version is simulated by
 * answering /_app/version.json with another value; `updated.check()` runs on tab focus, which the test triggers with a focus event.
 */

const VERSION_JSON = '**/_app/version.json';

async function simulateNewVersion(page: import('@playwright/test').Page) {
	await page.route(VERSION_JSON, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			headers: { 'cache-control': 'no-store' },
			body: JSON.stringify({ version: 'a-newer-build' })
		})
	);
	// Until the page has hydrated nothing listens for focus: repeat until the banner shows.
	await expect(async () => {
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(page.locator('.update')).toBeVisible({ timeout: 1000 });
	}).toPass({ timeout: 15_000 });
}

/** Release versions from src/lib/content/releases/*.md, newest first. */
function releaseVersions(): string[] {
	const parts = (v: string) => v.split('.').map(Number);
	return readdirSync('src/lib/content/releases')
		.filter((f) => /^\d+\.\d+\.\d+\.md$/.test(f))
		.map((f) => f.replace(/\.md$/, ''))
		.sort((a, b) => {
			const [x, y] = [parts(a), parts(b)];
			return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!;
		});
}

test.describe('release notes', () => {
	test('/releases lists the newest version first with anchors', async ({ page }) => {
		await page.goto('/releases');
		await expect(page.getByRole('heading', { level: 1, name: "What's new" })).toBeVisible();
		const headings = page.locator('article.release h2');
		// The newest two release files, so the test never needs a bump when a version ships.
		const [newest, previous] = releaseVersions();
		await expect(headings.first()).toContainText(`Version ${newest}`);
		await expect(headings.nth(1)).toContainText(`Version ${previous}`);
		await expect(page.locator(`#v${newest!.replaceAll('.', '-')}`)).toBeVisible();
		await expectNoHorizontalOverflow(page);
	});

	test('the New dot shows until the notes are opened', async ({ page, viewport }) => {
		await page.goto('/');
		const phone = viewport!.width < 768;
		if (phone) await page.locator('nav.tabbar summary').click();
		const link = page.locator(phone ? '.sheet a[href="/releases"]' : 'aside a[href="/releases"]');
		await expect(link.getByRole('img', { name: 'New' })).toBeVisible();
		await link.click();
		await expect(page.getByRole('heading', { level: 1, name: "What's new" })).toBeVisible();
		await page.goto('/');
		if (phone) await page.locator('nav.tabbar summary').click();
		await expect(link).toBeVisible();
		await expect(link.getByRole('img', { name: 'New' })).toHaveCount(0);
	});

	test('the version file is never cached', async ({ request }) => {
		const response = await request.get('/_app/version.json');
		expect(response.ok()).toBe(true);
		expect(response.headers()['cache-control']).toContain('no-store');
	});
});

test.describe('update banner', () => {
	test('appears on a new version; Reload reloads; What’s new links to /releases', async ({
		page,
		viewport
	}) => {
		await page.goto('/');
		await expect(page.getByText('A new version of Ruby is available.')).toHaveCount(0);
		await simulateNewVersion(page);
		const banner = page.locator('.update');
		await expect(banner).toBeVisible();
		await expect(banner).toContainText('A new version of Ruby is available.');
		await expectNoHorizontalOverflow(page);

		const reload = banner.getByRole('button', { name: 'Reload' });
		const link = banner.getByRole('link', { name: "What's new" });
		if (viewport!.width < 768) {
			for (const el of [reload, link]) {
				const box = (await el.boundingBox())!;
				expect(box.height).toBeGreaterThanOrEqual(44);
			}
			// Sits above the tab bar.
			const b = (await banner.boundingBox())!;
			const tab = (await page.locator('nav.tabbar').boundingBox())!;
			expect(b.y + b.height).toBeLessThanOrEqual(tab.y);
		}

		await page.evaluate(() => ((window as never as { marker: string }).marker = 'old'));
		await reload.click();
		await page.waitForLoadState('load');
		const marker = await page.evaluate(() => (window as never as { marker?: string }).marker);
		expect(marker).toBeUndefined();

		await simulateNewVersion(page);
		await banner.getByRole('link', { name: "What's new" }).click();
		await expect(page).toHaveURL(/\/releases$/);
	});

	test('Reload asks first when a form holds unsaved input', async ({ page }) => {
		await page.goto('/account');
		await simulateNewVersion(page);
		await expect(page.locator('.update')).toBeVisible();
		await page.getByLabel('Name').fill('Someone Else Entirely');
		await page.locator('.update').getByRole('button', { name: 'Reload' }).click();
		const dialog = page.getByRole('dialog', { name: /lose your changes/ });
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: 'Keep editing' }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByLabel('Name')).toHaveValue('Someone Else Entirely');

		await page.locator('.update').getByRole('button', { name: 'Reload' }).click();
		await page.getByRole('button', { name: 'Reload anyway' }).click();
		await page.waitForLoadState('load');
		await expect(page.getByLabel('Name')).not.toHaveValue('Someone Else Entirely');
	});

	test('after an update the next client-side navigation is a full page load', async ({ page }) => {
		await page.goto('/');
		await page.evaluate(() => ((window as never as { marker: string }).marker = 'old'));
		await simulateNewVersion(page);
		await expect(page.locator('.update')).toBeVisible();
		await page.locator('nav:visible a[href="/my-tasks"]').click();
		await expect(page).toHaveURL(/\/my-tasks$/);
		await page.waitForLoadState('load');
		const marker = await page.evaluate(() => (window as never as { marker?: string }).marker);
		expect(marker).toBeUndefined();
	});
	test('after an update, following a link with unsaved input asks first', async ({ page }) => {
		await page.goto('/account');
		await page.waitForLoadState('networkidle');
		await simulateNewVersion(page);
		await expect(page.locator('.update')).toBeVisible();
		await page.getByLabel('Name').fill('Unsaved Name Change');
		await page.locator('nav:visible a[href="/my-tasks"]').click();
		const dialog = page.getByRole('dialog', { name: /lose your changes/ });
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: 'Keep editing' }).click();
		await expect(page).toHaveURL(/\/account$/);
		await expect(page.getByLabel('Name')).toHaveValue('Unsaved Name Change');
		await page.locator('nav:visible a[href="/my-tasks"]').click();
		await page.getByRole('button', { name: 'Reload anyway' }).click();
		await expect(page).toHaveURL(/\/my-tasks$/);
	});
});
