import { expect, test } from '@playwright/test';

/**
 * RB-06 QA probes. (1) A choice made in the kit Select before hydration survives it (D1, fixed by the
 * RB-10 kit on main). (2) Flipped in cycle 2 and again in
 * cycle 3: the seed's second admin is an eligible approver, so the sole HR user gets no self-approval note (N1).
 * Desktop only.
 */
test('FIXED probe (RB-10 kit): a leave type chosen before hydration survives it', async ({
	page
}, info) => {
	test.skip(info.project.name !== 'desktop', 'probe runs once');
	await page.route('**/_app/immutable/**', async (route) => {
		await new Promise((r) => setTimeout(r, 1500));
		await route.continue();
	});
	await page.goto('/time-off', { waitUntil: 'domcontentloaded' });
	const select = page.getByLabel('Leave type');
	await expect(select).toBeVisible();
	const options = await select.locator('option').allTextContents();
	const other = options.find((o) => o !== options[0]);
	await select.selectOption({ label: other! });
	expect(await select.locator('option:checked').textContent()).toBe(other);
	await page.waitForLoadState('networkidle');
	const after = await select.locator('option:checked').textContent();
	expect(after).toBe(other);
});

test('FIXED probe (cycle 3, N1): with a second admin in the seed, the sole-HR owner gets no self-approval note', async ({
	page
}, info) => {
	test.skip(info.project.name !== 'desktop', 'probe runs once');
	const note = 'No one else can approve your requests yet; you can approve them yourself (logged).';
	for (const path of ['/time-off', '/time-off/approvals']) {
		await page.goto(path);
		await page.waitForLoadState('networkidle');
		await expect(page.locator('main').getByText(note)).toHaveCount(0);
	}
});
