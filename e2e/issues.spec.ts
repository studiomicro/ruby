import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers';

/**
 * Issues and team labels at iPhone 17 / 17 Pro / 18 Pro (402 × 874), 440 × 956, 360 px and desktop: the Issues list
 * (rows instead of a table on phones, filters in a sheet that returns focus, the bulk bar clear of the tab bar),
 * Report an issue (with and without JavaScript) and the admin's team labels. No horizontal page scroll; touch
 * targets ≥ 44 px on phones. Each viewport works in its own fictional project, set up through the UI once.
 */

test.describe.configure({ mode: 'serial' });

const KEYS: Record<string, string> = {
	'iphone-402': 'ISA',
	'iphone-440': 'ISB',
	'phone-360': 'ISC',
	desktop: 'ISD'
};
const keyOf = (info: { project: { name: string }; repeatEachIndex: number }) =>
	`${KEYS[info.project.name] ?? 'ISX'}${info.repeatEachIndex || ''}`;
const isPhone = (page: Page) => page.viewportSize()!.width < 768;
const box = async (locator: Locator) => {
	const b = await locator.boundingBox();
	if (!b) throw new Error('element has no box');
	return b;
};
const expectTapTarget = async (page: Page, locator: Locator) => {
	if (!isPhone(page)) return;
	const b = await box(locator);
	expect(b.height).toBeGreaterThanOrEqual(44);
	expect(b.width).toBeGreaterThanOrEqual(44);
};
const tap = async (page: Page, locator: Locator) =>
	isPhone(page) ? locator.tap() : locator.click();

async function reportIssue(page: Page, key: string, title: string) {
	await page.goto(`/issues/new?project=${key}`);
	await expect(page.getByLabel('Project')).toHaveValue(key);
	await page.getByLabel('Title').fill(title);
	await page.getByRole('button', { name: 'Report issue' }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${key}/tasks/\\d+\\?reported=`));
}

/** The project with three reported bugs (created once per viewport). */
async function ensureProject(page: Page, key: string) {
	const response = await page.goto(`/projects/${key}`);
	if (response?.status() === 200) return;
	await page.goto('/projects/new');
	await page.getByLabel('Key').fill(key);
	await page.getByLabel('Name').fill(`Issues ${key}`);
	await page.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(`/projects/${key}`);
	for (const title of ['Login button misaligned', 'Export is slow', 'Dark mode contrast'])
		await reportIssue(page, key, title);
}

test.beforeEach(async ({ page }, info) => {
	await ensureProject(page, keyOf(info));
});

test('Issues: rows fit the screen, filters in a sheet that returns focus, bulk bar clears the tab bar', async ({
	page
}, info) => {
	const key = keyOf(info);
	await page.goto(`/issues?project=${key}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Issues' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Report an issue' }).first()).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expect(page.getByRole('link', { name: `Project ${key} (remove)` })).toBeVisible();
	await expectTapTarget(page, page.getByRole('link', { name: `Project ${key} (remove)` }));

	if (isPhone(page)) {
		await expect(page.locator('ul.narrow li.row').first()).toBeVisible();
		await expect(page.locator('.wide')).toBeHidden();
		const open = page.getByRole('button', { name: /^Filters/ });
		await expectTapTarget(page, open);
		await open.tap();
		const sheet = page.getByRole('dialog', { name: 'Filters' });
		await expect(sheet).toBeVisible();
		await expect(sheet.getByRole('button', { name: 'Show results' })).toBeVisible();
		await expectTapTarget(page, sheet.locator('label.check').first());
		await expectNoHorizontalOverflow(page);
		await sheet.getByRole('button', { name: 'Close' }).tap();
		await expect(sheet).toBeHidden();
		await expect(open).toBeFocused();
	} else {
		await expect(page.locator('.wide table')).toBeVisible();
		await page.locator('summary', { hasText: 'Filters' }).click();
		await expect(page.getByRole('button', { name: 'Show results' })).toBeVisible();
	}

	const rows = isPhone(page) ? page.locator('ul.narrow li.row') : page.locator('.wide tbody tr');
	const pick = rows.first().locator('.pick-box');
	await expectTapTarget(page, pick);
	await tap(page, pick);
	const panel = page.locator('#bulk-form-panel');
	await expect(panel.getByRole('heading', { name: '1 selected' })).toBeVisible();
	const bar = page.locator('.selection-bar');
	await expect(bar).toContainText('1 selected');
	if (isPhone(page)) {
		await bar.scrollIntoViewIfNeeded();
		const tabbar = await box(page.locator('nav.tabbar'));
		const sticky = await box(bar);
		expect(sticky.y + sticky.height).toBeLessThanOrEqual(tabbar.y);
	}
	await panel.getByLabel('Set type').selectOption('improvement');
	await panel.getByRole('button', { name: 'Update selected issues' }).click();
	await expect(page.getByText('1 issue updated.').first()).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('Report an issue: single column, fits, files a task', async ({ page }, info) => {
	const key = keyOf(info);
	await page.goto('/issues/new');
	await expect(page.getByRole('heading', { level: 1, name: 'Report an issue' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expectTapTarget(page, page.getByRole('button', { name: 'Report issue' }));
	await page.getByLabel('Project').selectOption(key);
	await page.getByLabel('Title').fill(`Reported from ${info.project.name}`);
	await page.getByRole('button', { name: 'Report issue' }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${key}/tasks/\\d+\\?reported=0-0`));
	await expect(page.getByText(new RegExp(`Reported ${key}-\\d+`)).first()).toBeVisible();
	await expect(page.getByText('Bug', { exact: true }).first()).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('Report is reachable: sidebar icon on desktop, first row of More on a phone', async ({
	page
}) => {
	await page.goto('/');
	if (isPhone(page)) {
		await page.locator('details.more > summary').tap();
		const rows = page.locator('.sheet .sheet-link');
		await expect(rows.nth(0)).toHaveText(/Report an issue/);
		await expect(rows.nth(1)).toHaveText(/Issues/);
		await expectTapTarget(page, rows.nth(0));
	} else {
		await page.locator('.side-actions').getByRole('link', { name: 'Report an issue' }).click();
		await expect(page).toHaveURL('/issues/new');
		await expect(page.locator('.sidebar').getByRole('link', { name: 'Issues' })).toBeVisible();
	}
});

test('admin team labels: fits, adds a label, delete asks for confirmation', async ({
	page
}, info) => {
	await page.goto('/admin/labels');
	await expect(page.getByRole('heading', { level: 1, name: 'Team labels' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	const name = `Team ${keyOf(info)} ${Date.now() % 100000}`;
	await page.getByLabel('Name').first().fill(name);
	await page.getByLabel('Colour').first().selectOption('green');
	await expectTapTarget(page, page.getByRole('button', { name: 'Add label' }));
	await page.getByRole('button', { name: 'Add label' }).click();
	await expect(page.getByText(`Team label “${name}” added.`).first()).toBeVisible();
	const row = page.locator('li.row', { hasText: name });
	await expect(row).toBeVisible();
	const summary = row.locator('summary');
	await expectTapTarget(page, summary);
	await tap(page, summary);
	await expect(row.getByText(/used\s+on 0\s+tasks/)).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await page.goto('/admin');
	await expect(page.getByRole('link', { name: /Team labels/ })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('without JavaScript: Report shows field errors, then files the task', async ({
	browser
}, info) => {
	test.skip(info.project.name !== 'desktop', 'no-JS flow: desktop');
	const key = keyOf(info);
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: info.project.use.storageState as string
	});
	const page = await context.newPage();
	try {
		await page.goto(`/issues/new?project=${key}`);
		await page.getByLabel('Title').fill(' ');
		await page.getByRole('button', { name: 'Report issue' }).click();
		await expect(page.getByText('Enter a title.')).toBeVisible();
		await page.getByLabel('Title').fill('Filed without JavaScript');
		await page.getByRole('button', { name: 'Report issue' }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${key}/tasks/\\d+\\?reported=`));
		await expect(page.getByText(new RegExp(`Reported ${key}-\\d+`))).toBeVisible();
		await page.goto(`/issues?project=${key}&type=bug`);
		await expect(page.getByRole('link', { name: /Filed without JavaScript/ })).toBeVisible();
	} finally {
		await context.close();
	}
});
