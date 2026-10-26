import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers';

/**
 * RB-10: a task in a far board column (Done) carries visually hidden text (priority, assignee). Positioned at its
 * static place, that text escaped the board's own sideways scroll box and widened a phone's layout viewport, so the
 * fixed tab bar ended up off-screen. The page must stay at the device width with the tab bar at its bottom edge.
 */

const KEYS: Record<string, string> = {
	'iphone-402': 'OVFA',
	'iphone-440': 'OVFB',
	'phone-360': 'OVFC',
	desktop: 'OVFD'
};

test('a task in the last board column does not widen the page', async ({
	page,
	viewport
}, info) => {
	const key = `${KEYS[info.project.name] ?? 'OVFX'}${info.repeatEachIndex || ''}`;
	if ((await page.goto(`/projects/${key}`))?.status() !== 200) {
		await page.goto('/projects/new');
		await page.getByLabel('Key').fill(key);
		await page.getByLabel('Name').fill('Board overflow check');
		await page.getByRole('button', { name: 'Create project' }).click();
		await expect(page).toHaveURL(`/projects/${key}`);
		await page.goto(`/projects/${key}/tasks/new`);
		await page.getByLabel('Title').fill('Finished long ago');
		await page.getByLabel('Status').selectOption('done');
		await page.getByLabel('Priority').selectOption('high');
		await page.getByLabel('Assignee').selectOption({ label: 'Ada Admin' });
		await page.getByRole('button', { name: 'Create task' }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${key}/tasks/\\d+$`));
	}
	await page.goto(`/projects/${key}?view=board`);
	await expect(page.locator('section[data-column="done"]')).toContainText('Finished long ago');
	await expectNoHorizontalOverflow(page);
	if (viewport!.width < 768) {
		const bar = await page.locator('nav.tabbar').boundingBox();
		expect(bar?.width).toBe(viewport!.width);
		expect((bar?.y ?? 0) + (bar?.height ?? 0)).toBeCloseTo(viewport!.height, 0);
	}
});
