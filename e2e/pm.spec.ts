import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers';

/**
 * RB-08 pages at iPhone 17 / 17 Pro / 18 Pro (402 × 874), 440 × 956, 360 px and desktop: settings (labels,
 * milestones, board columns), the board with a renamed column, a WIP warning and a hidden column, bulk edit by touch,
 * the task checklist and labels, and the milestone page. No horizontal page scroll; touch targets ≥ 44 px on phones;
 * nothing needs hover. Each viewport works in its own fictional project, set up through the UI on the first run.
 */

test.describe.configure({ mode: 'serial' });

const KEYS: Record<string, string> = {
	'iphone-402': 'PMA',
	'iphone-440': 'PMB',
	'phone-360': 'PMC',
	desktop: 'PMD'
};
const keyOf = (info: { project: { name: string }; repeatEachIndex: number }) =>
	`${KEYS[info.project.name] ?? 'PMX'}${info.repeatEachIndex || ''}`;
const isPhone = (page: Page) => page.viewportSize()!.width < 768;
const box = async (locator: Locator) => {
	const b = await locator.boundingBox();
	if (!b) throw new Error('element has no box');
	return b;
};
const expectTapTarget = async (page: Page, locator: Locator) => {
	if (isPhone(page)) expect((await box(locator)).height).toBeGreaterThanOrEqual(44);
};

async function createTask(page: Page, key: string, title: string) {
	await page.goto(`/projects/${key}/tasks/new`);
	await page.getByLabel('Title').fill(title);
	await page.getByRole('button', { name: 'Create task' }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${key}/tasks/\\d+$`));
}

/** The project with three tasks, a label, a milestone, a WIP limit of 1 on To do, "In review" as "QA", Canceled hidden. */
async function ensureProject(page: Page, key: string) {
	const response = await page.goto(`/projects/${key}`);
	if (response?.status() === 200) return;
	await page.goto('/projects/new');
	await page.getByLabel('Key').fill(key);
	await page.getByLabel('Name').fill(`PM plus ${key}`);
	await page.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(`/projects/${key}`);
	for (const title of ['Draft the release notes', 'Second step task', 'Third task'])
		await createTask(page, key, title);

	await page.goto(`/projects/${key}/settings`);
	const labels = page.getByRole('region', { name: 'Labels' });
	await labels.getByLabel('Name').fill('Bug');
	await labels.getByLabel('Colour').selectOption('red');
	await labels.getByRole('button', { name: 'Add label' }).click();
	await expect(labels.getByText('Label “Bug” added.')).toBeVisible();

	const milestones = page.getByRole('region', { name: 'Milestones' });
	await milestones.getByLabel('Name').fill('Beta');
	await milestones.getByRole('button', { name: 'Add milestone' }).click();
	await expect(milestones.getByText('Milestone “Beta” added.')).toBeVisible();

	const columns = page.getByRole('region', { name: 'Board columns' });
	await columns
		.getByRole('group', { name: /^To do/ })
		.getByLabel('WIP limit')
		.fill('1');
	await columns
		.getByRole('group', { name: /^In review/ })
		.getByLabel('Name')
		.fill('QA');
	await columns
		.getByRole('group', { name: /^Canceled/ })
		.getByLabel('Hidden')
		.check();
	await columns.getByRole('button', { name: 'Save columns' }).click();
	await expect(columns.getByText('Board columns saved.')).toBeVisible();
}

test.beforeEach(async ({ page }, info) => {
	await ensureProject(page, keyOf(info));
});

test('settings: labels, milestones and columns fit the screen', async ({ page }, info) => {
	const key = keyOf(info);
	await page.goto(`/projects/${key}/settings`);
	await expect(page.getByRole('heading', { name: 'Board columns' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	const labels = page.getByRole('region', { name: 'Labels' });
	await expect(labels.getByText('Bug', { exact: true })).toBeVisible();
	const edit = labels.locator('summary').first();
	await expectTapTarget(page, edit);
	await edit.click();
	await expect(labels.getByRole('button', { name: 'Save label' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	const columns = page.getByRole('region', { name: 'Board columns' });
	await expectTapTarget(page, columns.locator('label.check').first());
	await expectTapTarget(page, columns.getByLabel('WIP limit').first());
});

test('board: renamed column, WIP warning, hidden column, scrolls inside its box', async ({
	page
}, info) => {
	const key = keyOf(info);
	await page.goto(`/projects/${key}?view=board`);
	const board = page.locator('.board');
	await expect(board.locator('section.column')).toHaveCount(5);
	await expect(board.getByRole('heading', { name: /^QA/ })).toBeVisible();
	await expect(page.getByText('1 hidden column.')).toBeVisible();
	const todo = board.locator('section[data-column="todo"]');
	await expect(todo.locator('.wip.over')).toContainText('Over limit');
	await expectNoHorizontalOverflow(page);
	await board.evaluate((el) => el.scrollBy({ left: 600 }));
	expect(await page.evaluate(() => window.scrollX)).toBe(0);
	await expectNoHorizontalOverflow(page);
});

test('bulk edit works by touch: select rows, set a label and priority', async ({ page }, info) => {
	const key = keyOf(info);
	await page.goto(`/projects/${key}`);
	const rows = page.locator('table.tasks tbody tr');
	await expect(rows.first()).toBeVisible();
	const panel = page.locator('#bulk-form-panel');
	await expect(panel).toBeHidden();
	const first = rows.nth(0).locator('.pick-box');
	const second = rows.nth(1).locator('.pick-box');
	await expectTapTarget(page, first);
	if (isPhone(page)) {
		await first.tap();
		await second.tap();
	} else {
		await first.click();
		await second.click();
	}
	await expect(panel.getByRole('heading', { name: '2 selected' })).toBeVisible();
	await expect(page.locator('.selection-bar')).toContainText('2 selected');
	await expectNoHorizontalOverflow(page);
	const apply = panel.getByRole('button', { name: 'Update selected tasks' });
	await expect(apply).toBeDisabled();
	await panel.getByLabel('Set priority').selectOption('urgent');
	await panel.getByLabel('Add label').selectOption({ label: 'Bug' });
	await expect(apply).toBeEnabled();
	await expectTapTarget(page, apply);
	await expectTapTarget(page, panel.getByLabel('Set priority'));
	await apply.click();
	await expect(page.getByText('2 tasks updated.')).toBeVisible();
	await expect(panel).toBeHidden();
	await expect(rows.nth(0).getByText('Bug', { exact: true })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('task: checklist step added and ticked, labels and milestone in the sidebar', async ({
	page
}, info) => {
	const key = keyOf(info);
	await page.goto(`/projects/${key}/tasks/1`);
	const checklist = page.getByRole('region', { name: 'Checklist' });
	await expect(checklist).toBeVisible();
	await expectNoHorizontalOverflow(page);
	const step = `Step ${Date.now()}`;
	await checklist.getByLabel('New step').fill(step);
	await expectTapTarget(page, checklist.getByRole('button', { name: 'Add step' }));
	await checklist.getByRole('button', { name: 'Add step' }).click();
	const tick = checklist.getByRole('button', { name: `Not done: ${step}` });
	await expect(tick).toBeVisible();
	await expectTapTarget(page, tick);
	await tick.click();
	await expect(checklist.getByRole('button', { name: `Done: ${step}` })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	// Ticking may have reloaded the page (before hydration a step form posts without JavaScript); a <select> picked
	// before hydration can be reset (see projects.spec QA F1), so retry the pick until the patch is confirmed.
	await expect(async () => {
		await page.getByLabel('Milestone').selectOption({ label: 'Beta' });
		await expect(page.getByRole('link', { name: 'Open milestone' })).toBeVisible({
			timeout: 3_000
		});
	}).toPass({ timeout: 20_000 });
	const change = page.getByText('Change labels');
	await expectTapTarget(page, change);
	await change.click();
	await expectNoHorizontalOverflow(page);
	await page.getByRole('link', { name: 'Open milestone' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Beta' })).toBeVisible();
	await expect(page.getByText(/of \d+ tasks done/)).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('without JavaScript: bulk edit and a checklist step still work', async ({ browser }, info) => {
	test.skip(info.project.name !== 'desktop', 'no-JS flow: desktop');
	const key = keyOf(info);
	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: info.project.use.storageState as string
	});
	const page = await context.newPage();
	try {
		await page.goto(`/projects/${key}`);
		const panel = page.locator('#bulk-form-panel');
		await expect(panel).toBeVisible();
		await page.locator('table.tasks tbody tr').first().locator('.pick-box input').check();
		await panel.getByLabel('Set priority').selectOption('low');
		await panel.getByRole('button', { name: 'Update selected tasks' }).click();
		await expect(page.getByText('1 task updated.')).toBeVisible();
		await page.goto(`/projects/${key}/tasks/2`);
		const checklist = page.getByRole('region', { name: 'Checklist' });
		const step = `No-JS step ${Date.now()}`;
		await checklist.getByLabel('New step').fill(step);
		await checklist.getByRole('button', { name: 'Add step' }).click();
		await expect(
			page.getByRole('region', { name: 'Checklist' }).getByText(step, { exact: true })
		).toBeVisible();
	} finally {
		await context.close();
	}
});
