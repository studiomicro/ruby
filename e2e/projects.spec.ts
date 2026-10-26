import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers';

/**
 * RB-01 pages at iPhone 17 / 17 Pro / 18 Pro (402 × 874), 440 × 956, 360 px and desktop: the projects list, a
 * project's list view, the board, a task and My tasks never scroll sideways; the board scrolls inside its own box
 * with one snap point per column; touch targets are at least 44 px on phones. Each viewport project works in its
 * own fictional project (created through the UI, so a re-run against a kept server finds it again).
 */

test.describe.configure({ mode: 'serial' });

const KEYS: Record<string, string> = {
	'iphone-402': 'LAYA',
	'iphone-440': 'LAYB',
	'phone-360': 'LAYC',
	desktop: 'LAYD'
};
/** The viewport's project key; a `--repeat-each` copy gets its own, so parallel repeats never share one. */
const keyOf = (info: { project: { name: string }; repeatEachIndex: number }) =>
	`${KEYS[info.project.name] ?? 'LAYX'}${info.repeatEachIndex || ''}`;
const isPhone = (width: number) => width < 768;
const box = async (locator: Locator) => {
	const b = await locator.boundingBox();
	if (!b) throw new Error('element has no box');
	return b;
};

async function createTask(page: Page, key: string, title: string, fields: { due?: string } = {}) {
	await page.goto(`/projects/${key}/tasks/new`);
	await page.getByLabel('Title').fill(title);
	await page.getByLabel('Assignee').selectOption({ label: 'Ada Admin' });
	await page.getByLabel('Priority').selectOption('high');
	if (fields.due) await page.getByLabel('Due date').fill(fields.due);
	await page.getByRole('button', { name: 'Create task' }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${key}/tasks/\\d+$`));
}

/** The viewport's project with three tasks; created on the first run only. */
async function ensureProject(page: Page, key: string) {
	const response = await page.goto(`/projects/${key}`);
	if (response?.status() === 200) return;
	await page.goto('/projects/new');
	await page.getByLabel('Key').fill(key);
	await page.getByLabel('Name').fill(`Layout check ${key} with a fairly long project name`);
	await page.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(`/projects/${key}`);
	await createTask(page, key, 'Prepare the quarterly review of the warehouse routing rules', {
		due: '2001-01-01'
	});
	await createTask(page, key, 'Second task');
	await createTask(
		page,
		key,
		'Third task with a title long enough to wrap onto two lines on a phone'
	);
}

test.beforeEach(async ({ page }, info) => {
	await ensureProject(page, keyOf(info));
});

test('projects list fits the screen', async ({ page }, info) => {
	const key = keyOf(info);
	await page.goto('/projects');
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	const link = page.getByRole('link', { name: new RegExp(`Layout check ${key} `) });
	await expect(link).toBeVisible();
	await expectNoHorizontalOverflow(page);
	if (isPhone(page.viewportSize()!.width))
		expect(
			(await box(page.locator('main li.row').filter({ has: link }))).height
		).toBeGreaterThanOrEqual(44);
});

test('project list view: stacked rows on phones, filters in a disclosure', async ({
	page
}, info) => {
	const key = keyOf(info);
	await page.goto(`/projects/${key}`);
	await expect(page.getByRole('heading', { level: 1, name: /Layout check/ })).toBeVisible();
	const rows = page.locator('table.tasks tbody tr');
	await expect(rows.first()).toBeVisible();
	await expect(page.getByText(/Showing 1–\d+ of \d+/)).toBeVisible();
	await expectNoHorizontalOverflow(page);
	// The overdue due date is marked.
	await expect(page.locator('table.tasks .overdue').first()).toBeVisible();
	await page.locator('details.filters summary').click();
	await expect(page.getByRole('button', { name: 'Apply' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	if (isPhone(page.viewportSize()!.width)) {
		await expect(page.locator('table.tasks thead')).toBeHidden();
		expect((await box(rows.first())).height).toBeGreaterThanOrEqual(44);
		expect((await box(page.locator('details.filters summary'))).height).toBeGreaterThanOrEqual(44);
		for (const check of await page.locator('details.filters .check').all())
			expect((await box(check)).height).toBeGreaterThanOrEqual(44);
	}
	// A filter is a shareable URL.
	// QA F1 (RB-05 cycle 2): picked before hydration finished, the bound <select> can be reset to its state value, so
	// Apply submitted no filter. Retry the pick-and-apply until the URL carries it.
	await expect(async () => {
		await page.getByLabel('Assignee').selectOption('none');
		await page.getByRole('button', { name: 'Apply' }).click();
		await expect(page).toHaveURL(/assignee=none/, { timeout: 3_000 });
	}).toPass({ timeout: 20_000 });
	await expect(page.getByText('No tasks match these filters')).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('board scrolls inside its own box, one snap per column', async ({ page }, info) => {
	const key = keyOf(info);
	await page.goto(`/projects/${key}?view=board`);
	const board = page.locator('.board');
	await expect(board.locator('section.column')).toHaveCount(6);
	await expectNoHorizontalOverflow(page);
	const metrics = await board.evaluate((el) => ({
		scrollWidth: el.scrollWidth,
		clientWidth: el.clientWidth,
		snap: getComputedStyle(el).scrollSnapType,
		columnSnap: getComputedStyle(el.querySelector('section.column')!).scrollSnapAlign
	}));
	expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
	expect(metrics.snap).toContain('x');
	expect(metrics.snap).toContain('mandatory');
	expect(metrics.columnSnap).toContain('start');
	const width = page.viewportSize()!.width;
	const first = await box(board.locator('section.column').first());
	expect(first.width).toBeLessThanOrEqual(width - 32);
	// Scrolling the board does not move the page sideways.
	await board.evaluate((el) => el.scrollBy({ left: 600 }));
	await expectNoHorizontalOverflow(page);
	expect(await page.evaluate(() => window.scrollX)).toBe(0);
	if (isPhone(width)) {
		const card = board.locator('[data-card]').first();
		expect((await box(card.locator('.handle'))).height).toBeGreaterThanOrEqual(44);
		expect((await box(card.locator('details.move summary'))).height).toBeGreaterThanOrEqual(44);
		expect((await box(board.locator('a.add').first())).height).toBeGreaterThanOrEqual(44);
	}
});

test('board: a keyboard move persists across a reload', async ({ page }, info) => {
	test.skip(isPhone(page.viewportSize()!.width), 'keyboard move: desktop');
	const key = keyOf(info);
	await page.goto(`/projects/${key}?view=board`);
	const handle = page.getByRole('button', { name: `Move ${key}-2` });
	await handle.focus();
	const column = (status: string) => page.locator(`section[data-column="${status}"]`);
	const before = (await column('todo').locator(`[data-card]`).count()) > 0 ? 'todo' : 'in_progress';
	await page.keyboard.press('Space');
	await page.keyboard.press(before === 'todo' ? 'ArrowRight' : 'ArrowLeft');
	// The drop shows at once; wait for the server's answer before reloading (a reload would cancel the request).
	const saved = page.waitForResponse(
		(r) => r.url().includes('/move') && r.request().method() === 'POST'
	);
	await page.keyboard.press('Enter');
	expect((await saved).ok()).toBe(true);
	const after = before === 'todo' ? 'in_progress' : 'todo';
	await expect(column(after).getByRole('link', { name: 'Second task' })).toBeVisible();
	await page.reload();
	await expect(column(after).getByRole('link', { name: 'Second task' })).toBeVisible();
});

test('task detail stacks the fields under the description on phones', async ({ page }, info) => {
	const key = keyOf(info);
	await page.goto(`/projects/${key}/tasks/1`);
	await expect(
		page.getByRole('heading', { level: 1, name: /Prepare the quarterly review/ })
	).toBeVisible();
	await expect(page.getByLabel('Status')).toBeVisible();
	await expectNoHorizontalOverflow(page);
	const main = await box(page.locator('section.main'));
	const fields = await box(page.locator('aside.fields'));
	if (isPhone(page.viewportSize()!.width)) {
		expect(fields.y).toBeGreaterThanOrEqual(main.y + main.height - 1);
		const fontSize = await page
			.getByLabel('Due date')
			.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
		expect(fontSize).toBeGreaterThanOrEqual(16);
		expect((await box(page.getByLabel('Status'))).height).toBeGreaterThanOrEqual(44);
	} else {
		expect(fields.x).toBeGreaterThan(main.x + main.width - 1);
	}
	await page.getByRole('link', { name: 'Edit' }).click();
	await expect(page.getByLabel('Title')).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('my tasks fits the screen', async ({ page }, info) => {
	const key = keyOf(info);
	await page.goto('/my-tasks');
	await expect(page.getByRole('heading', { level: 1, name: 'My tasks' })).toBeVisible();
	await expect(page.getByRole('heading', { name: /Overdue/ })).toBeVisible();
	await expect(page.locator('main').getByText(`${key}-1`, { exact: true })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});
