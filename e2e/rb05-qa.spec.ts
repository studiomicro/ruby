import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, STORAGE_STATE } from './helpers';
import { SEED_EMPLOYEES } from '../scripts/seed-data';

/** RB-05 QA: the no-JS reveal page, and every HR page fits each phone width. */

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false, storageState: STORAGE_STATE });

	test('create, store NIK and reveal work as plain forms; value shown once, no-store', async ({
		page
	}) => {
		const name = `NoJs Person ${unique()}`;
		await page.goto('/people/new');
		await page.getByLabel('Full name').fill(name);
		await page.getByRole('button', { name: 'Create employee' }).click();
		await page.waitForURL(/\/people\/[0-9a-f-]{36}\?notice=created$/);
		const id = new URL(page.url()).pathname.split('/')[2]!;
		await page.goto(`/people/${id}/edit`);
		await page.getByLabel('NIK', { exact: true }).fill('3171000099995678');
		await page.getByRole('button', { name: 'Save sensitive details' }).click();
		await expect(page.getByText('Sensitive details saved.')).toBeVisible();
		await page.goto(`/people/${id}`);
		const html = await page.content();
		expect(html).not.toContain('3171000099995678');
		expect(html).toContain('5678');
		const nik = page.locator('dl > div').filter({ has: page.getByText('NIK', { exact: true }) });
		const [resp] = await Promise.all([
			page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('reveal')),
			nik.getByRole('button', { name: /Reveal NIK/ }).click()
		]);
		expect(resp.headers()['cache-control']).toContain('no-store');
		await expect(page.getByText('3171000099995678')).toBeVisible();
		await expectNoHorizontalOverflow(page);
		// a fresh load never carries the value
		await page.goto(`/people/${id}`);
		expect(await page.content()).not.toContain('3171000099995678');
		// reveal audited
		await page.goto('/hr/audit?action=sensitive_view');
		await expect(page.getByText(`Sensitive field revealed · ${name}`).first()).toBeVisible();
	});
});

test('every HR page fits the viewport', async ({ page }) => {
	const id = SEED_EMPLOYEES[2][0];
	for (const path of [
		'/people',
		'/people?status=all',
		'/people/org',
		'/people/new',
		`/people/${id}`,
		`/people/${id}/edit`,
		'/hr/audit',
		'/admin/users'
	]) {
		const res = await page.goto(path);
		expect(res?.status(), path).toBe(200);
		await expectNoHorizontalOverflow(page);
	}
});
