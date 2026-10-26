import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers';

/**
 * Knowledge base and search layout (RB-02) at every project size: no sideways page scroll, the page tree as a
 * collapsible section on phones and a side column on wide screens, Write | Preview tabs below 1100 px and side by
 * side above, code blocks and tables scrolling inside their own box, 44 px touch targets. Every test writes its own
 * pages (the projects run in parallel against one local database).
 */

const isPhone = (width: number) => width < 768;
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const BODY = [
	'# Overview',
	'',
	'A paragraph with a very-long-unbroken-identifier-that-should-wrap-instead-of-widening-the-page-at-all.',
	'',
	'```',
	'const reallyLongLine = "this code line is far wider than any phone screen and must scroll inside its own box";',
	'```',
	'',
	'| Column one | Column two | Column three | Column four | Column five | Column six |',
	'| --- | --- | --- | --- | --- | --- |',
	'| alpha value | beta value | gamma value | delta value | epsilon value | zeta value |'
].join('\n');

async function createPage(
	page: Page,
	title: string,
	body = BODY,
	parent?: string
): Promise<string> {
	await page.goto(parent ? `/kb/new?parent=${parent}` : '/kb/new');
	await page.getByLabel('Title', { exact: true }).fill(title);
	await page.getByLabel('Body', { exact: true }).fill(body);
	await page.getByRole('button', { name: 'Create page' }).click();
	await page.waitForURL(/\/kb\/[0-9a-f-]{36}\?notice=created$/);
	await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
	return new URL(page.url()).pathname.slice(4);
}

/** On a touch screen every visible control in the main column is at least 44 px tall. */
async function expectTouchTargets(page: Page, width: number) {
	if (!isPhone(width)) return;
	const small = await page
		.locator('main')
		.locator('button, .btn, summary, select, input:not([type="hidden"]), textarea')
		.evaluateAll((els) =>
			els
				.filter((el) => (el as HTMLElement).offsetParent !== null)
				.map((el) => ({ el: el.outerHTML.slice(0, 80), h: el.getBoundingClientRect().height }))
				.filter((x) => x.h < 44)
		);
	expect(small).toEqual([]);
}

test('the knowledge base index fits the screen', async ({ page, viewport }) => {
	await page.goto('/kb');
	await expect(page.getByRole('heading', { level: 1, name: 'Knowledge base' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'New page' }).first()).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);
});

test('a page view: tree drawer on phones, side column on wide screens, boxed code and tables', async ({
	page,
	viewport
}) => {
	const word = unique();
	const parent = await createPage(page, `Parent ${word}`);
	await createPage(page, `Child ${word}`, BODY, parent);
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);

	// Code blocks and tables scroll inside their own box, never the page.
	for (const selector of ['.markdown pre', '.markdown table']) {
		const box = page.locator(selector).first();
		const { client, offsetRight } = await box.evaluate((el) => ({
			client: el.clientWidth,
			offsetRight: el.getBoundingClientRect().right
		}));
		expect(client).toBeGreaterThan(0);
		expect(offsetRight).toBeLessThanOrEqual(viewport!.width);
	}

	const drawer = page.locator('details.tree-drawer');
	const aside = page.locator('aside.tree-aside');
	if (viewport!.width < 1100) {
		await expect(drawer).toBeVisible();
		await expect(aside).toBeHidden();
		await expect(drawer.getByRole('link', { name: `Child ${word}` })).toBeHidden();
		await drawer.locator('summary').first().click();
		await expect(drawer.getByRole('link', { name: `Child ${word}` })).toBeVisible();
		await expectNoHorizontalOverflow(page);
	} else {
		await expect(drawer).toBeHidden();
		await expect(aside.getByRole('link', { name: `Child ${word}` })).toBeVisible();
	}
	await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
		`Parent ${word}`
	);
});

test('the editor: tabs on phones, side by side on wide screens; history lists both revisions', async ({
	page,
	viewport
}) => {
	const word = unique();
	const id = await createPage(page, `Editable ${word}`, 'First **version**.');
	await page.goto(`/kb/${id}/edit`);
	await expect(page.getByLabel('Body', { exact: true })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);

	const preview = page.locator('.preview-pane');
	if (viewport!.width < 1100) {
		await expect(preview).toBeHidden();
		await page.getByRole('button', { name: 'Preview' }).click();
		await expect(preview).toBeVisible();
		await expect(preview.locator('strong')).toHaveText('version');
		await expect(page.getByLabel('Body', { exact: true })).toBeHidden();
		await expectNoHorizontalOverflow(page);
		await page.getByRole('button', { name: 'Write' }).click();
	} else {
		await expect(preview).toBeVisible();
		await expect(page.getByLabel('Body', { exact: true })).toBeVisible();
		const [write, view] = await Promise.all([
			page.locator('.write-pane').boundingBox(),
			preview.boundingBox()
		]);
		expect(view!.x).toBeGreaterThan(write!.x + write!.width - 1);
	}

	await page.getByLabel('Body', { exact: true }).fill('Second version.');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.waitForURL(`/kb/${id}?notice=saved`);
	await expect(page.getByText('Page saved.')).toBeVisible();
	await expect(page.getByText('Revision 2')).toBeVisible();

	await page.goto(`/kb/${id}/history`);
	await expect(page.locator('ol.revisions > li')).toHaveCount(2);
	await expect(page.getByText('Current')).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);

	await page.goto(`/kb/${id}/history/1`);
	await expect(page.getByRole('button', { name: 'Restore this version' })).toBeVisible();
	await expect(page.locator('.markdown strong')).toHaveText('version');
	await expectNoHorizontalOverflow(page);
});

test('move and delete forms fit the screen', async ({ page, viewport }) => {
	const id = await createPage(page, `Movable ${unique()}`, 'Body');
	for (const path of [`/kb/${id}/move`, `/kb/${id}/delete`]) {
		await page.goto(path);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		await expectNoHorizontalOverflow(page);
		await expectTouchTargets(page, viewport!.width);
	}
});

test('search finds the page, highlights the hit and fits the screen', async ({
	page,
	viewport
}) => {
	const word = `zq${unique()}`;
	await createPage(page, `Searchable ${word}`, `Body mentioning ${word} once.`);
	await page.goto('/search');
	await expect(page.getByText('Type to search pages and tasks.')).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await page.getByRole('searchbox', { name: 'Search' }).fill(word);
	await page.locator('main').getByRole('button', { name: 'Search' }).click();
	await page.waitForURL(/\/search\?q=/);
	const hit = page.locator('.hit').filter({ hasText: `Searchable ${word}` });
	await expect(hit).toBeVisible();
	await expect(hit.locator('mark').first()).toHaveText(word);
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);

	await page.goto('/search?q=%22%28*%29%22');
	await expect(page.getByText('Use at least one letter or number.')).toBeVisible();
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('create with a server preview, then edit and save', async ({ page }) => {
		const title = `No JS ${unique()}`;
		await page.goto('/kb/new');
		await page.getByLabel('Title', { exact: true }).fill(title);
		await page.getByLabel('Body', { exact: true }).fill('Some **bold** text.');
		await page.getByRole('button', { name: 'Preview' }).click();
		await expect(page.locator('.server-preview strong')).toHaveText('bold');
		await expect(page.getByLabel('Title', { exact: true })).toHaveValue(title);
		await expectNoHorizontalOverflow(page);
		await page.getByRole('button', { name: 'Create page' }).click();
		await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
		await expect(page.getByText('Page created.')).toBeVisible();
		const id = new URL(page.url()).pathname.slice(4);
		await page.goto(`/kb/${id}/edit`);
		await page.getByLabel('Body', { exact: true }).fill('Changed.');
		// Clear of the fixed tab bar (Playwright scrolls a target only to the viewport's edge).
		const save = page.getByRole('button', { name: 'Save', exact: true });
		await save.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await save.click();
		await expect(page.getByText('Page saved.')).toBeVisible();
		await expect(page.getByText('Revision 2')).toBeVisible();
	});
});
