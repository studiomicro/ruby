import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow as fitsWidth, STORAGE_STATE } from './helpers';

/**
 * RB-04 attachments at every project size: upload, list, download and delete on a task and on a knowledge-base
 * page, with no sideways page scroll and 44 px touch targets on phones; plus the same flow with JavaScript off.
 * Every test makes its own project, task or page (projects run in parallel against one local database). One run
 * uploads 17 files as the seeded admin, inside the `upload` budget of 20 per 10 minutes; `--repeat-each` beyond 1
 * is throttled by design.
 */

const isPhone = (width: number) => width < 768;

/**
 * No sideways scroll, and the layout viewport is still the device width: a phone browser widens the layout viewport
 * to fit content that is too wide, which a scrollWidth check alone would not see.
 */
async function expectNoHorizontalOverflow(page: Page) {
	await fitsWidth(page);
	const width = page.viewportSize()?.width;
	expect(await page.evaluate(() => window.innerWidth)).toBe(width);
}
const unique = () =>
	`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const PNG = Buffer.from(
	'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201e2d6b9460000000049454e44ae426082',
	'hex'
);

async function newTask(page: Page): Promise<string> {
	const key = `A${unique().slice(-7)}`;
	await page.goto('/projects/new');
	await page.getByLabel('Key').fill(key);
	await page.getByLabel('Name').fill(`Attachments ${key}`);
	await page.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(`/projects/${key}`);
	await page.goto(`/projects/${key}/tasks/new`);
	await page.getByLabel('Title').fill('Collect the signed delivery notes');
	await page.getByRole('button', { name: 'Create task' }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${key}/tasks/\\d+$`));
	return new URL(page.url()).pathname;
}

async function newPage(page: Page): Promise<string> {
	await page.goto('/kb/new');
	await page.getByLabel('Title', { exact: true }).fill(`Attachments ${unique()}`);
	await page.getByLabel('Body', { exact: true }).fill('Fictional page with files.');
	await page.getByRole('button', { name: 'Create page' }).click();
	await page.waitForURL(/\/kb\/[0-9a-f-]{36}\?notice=created$/);
	return new URL(page.url()).pathname;
}

/** On a touch screen every visible control in the panel is at least 44 px tall. */
async function expectTouchTargets(page: Page, width: number) {
	if (!isPhone(width)) return;
	const small = await page
		.locator('#attachments')
		.locator('a, button, .btn, summary, input:not([type="hidden"])')
		.evaluateAll((els) =>
			els
				.filter((el) => (el as HTMLElement).offsetParent !== null)
				.map((el) => ({ el: el.outerHTML.slice(0, 80), h: el.getBoundingClientRect().height }))
				.filter((x) => x.h < 44)
		);
	expect(small).toEqual([]);
}

/** Upload, list, download, delete through the JavaScript panel. */
async function roundTrip(
	page: Page,
	width: number,
	file: { name: string; mimeType: string; buffer: Buffer }
) {
	const panel = page.locator('#attachments');
	await expect(panel.getByText('No attachments')).toBeVisible();
	await expect(panel.getByText('0 of 20')).toBeVisible();
	// iOS Safari: a plain file input, no `capture`, no `accept` filter.
	const input = panel.locator('input[type="file"]');
	expect(await input.getAttribute('capture')).toBeNull();
	expect(await input.getAttribute('accept')).toBeNull();
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, width);

	await input.setInputFiles(file);
	await panel.getByRole('button', { name: 'Upload' }).click();
	const link = panel.getByRole('link', { name: file.name });
	await expect(link).toBeVisible();
	await expect(panel.getByText('1 of 20')).toBeVisible();
	await expect(
		panel.locator('.queue li', { hasText: file.name }).getByText('Uploaded')
	).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, width);

	const href = await link.getAttribute('href');
	expect(href).toMatch(/^\/files\/[0-9a-f-]{36}$/);
	const res = await page.request.get(href!);
	expect(res.status()).toBe(200);
	expect(res.headers()['content-disposition']).toMatch(/^attachment; filename="/);
	expect(res.headers()['x-content-type-options']).toBe('nosniff');
	expect(res.headers()['content-security-policy']).toBe(
		"sandbox; default-src 'none'; frame-ancestors 'none'"
	);
	expect(res.headers()['x-frame-options']).toBe('DENY');
	expect(Buffer.from(await res.body())).toEqual(file.buffer);

	page.once('dialog', (d) => void d.accept());
	await panel.getByRole('button', { name: `Delete ${file.name}` }).click();
	await expect(panel.getByText('No attachments')).toBeVisible();
	expect((await page.request.get(href!)).status()).toBe(404);
}

test('a task: upload, list, download and delete', async ({ page, viewport }) => {
	await newTask(page);
	await roundTrip(page, viewport!.width, {
		name: `Delivery notes with a long descriptive name for ${unique()}.pdf`,
		mimeType: 'application/pdf',
		buffer: Buffer.from('%PDF-1.7 fictional delivery notes')
	});
});

test('a page: an image with a thumbnail, then download and delete', async ({ page, viewport }) => {
	await newPage(page);
	const name = `floor-plan-${unique()}.png`;
	const panel = page.locator('#attachments');
	await panel
		.locator('input[type="file"]')
		.setInputFiles({ name, mimeType: 'image/png', buffer: PNG });
	await panel.getByRole('button', { name: 'Upload' }).click();
	await expect(panel.getByRole('link', { name })).toBeVisible();
	const thumb = panel.locator('img.thumb');
	await expect(thumb).toHaveAttribute('loading', 'lazy');
	await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
	const src = await thumb.getAttribute('src');
	expect((await page.request.get(src!)).headers()['content-disposition']).toMatch(/^inline; /);
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);
	page.once('dialog', (d) => void d.accept());
	await panel.getByRole('button', { name: `Delete ${name}` }).click();
	await expect(panel.getByText('No attachments')).toBeVisible();
	// The same flow then works for a document on a page.
	await roundTrip(page, viewport!.width, {
		name: `minutes-${unique()}.txt`,
		mimeType: 'text/plain',
		buffer: Buffer.from('Fictional minutes.')
	});
});

test('an empty file is refused in the panel before it is sent', async ({ page }) => {
	await newPage(page);
	const panel = page.locator('#attachments');
	await panel
		.locator('input[type="file"]')
		.setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
	await panel.getByRole('button', { name: 'Upload' }).click();
	await expect(panel.getByRole('alert')).toHaveText('File is empty');
	await expect(panel.getByText('No attachments')).toBeVisible();
});

test('a file larger than one 5 MiB part streams to R2 in parts and downloads intact', async ({
	page
}, info) => {
	test.skip(info.project.name !== 'desktop', 'one large upload per run (the upload budget)');
	await newPage(page);
	const panel = page.locator('#attachments');
	const buffer = Buffer.alloc(6 * 1024 * 1024 + 123);
	for (let i = 0; i < buffer.length; i += 4096) buffer[i] = i % 251;
	const name = `survey-${unique()}.bin`;
	await panel
		.locator('input[type="file"]')
		.setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
	await panel.getByRole('button', { name: 'Upload' }).click();
	const link = panel.getByRole('link', { name });
	await expect(link).toBeVisible({ timeout: 20_000 });
	await expect(panel.getByText('6 MB')).toBeVisible();
	const res = await page.request.get((await link.getAttribute('href'))!);
	expect(res.headers()['content-length']).toBe(String(buffer.length));
	expect(Buffer.from(await res.body()).equals(buffer)).toBe(true);
});

test('the admin retention page fits the screen', async ({ page, viewport }) => {
	await page.goto('/admin/attachments');
	await expect(page.getByRole('heading', { level: 1, name: 'Attachment retention' })).toBeVisible();
	await expect(page.getByText('Nothing to purge.')).toBeVisible();
	await expectNoHorizontalOverflow(page);
	void viewport;
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('upload and delete post forms and come back with a message', async ({
		page,
		viewport,
		browser
	}, info) => {
		// The page is written with JavaScript on (RB-02's editor is not under test here), then opened without it.
		const setup = await browser.newContext({
			storageState: STORAGE_STATE,
			baseURL: info.project.use.baseURL,
			// newContext inherits this describe's javaScriptEnabled: false.
			javaScriptEnabled: true
		});
		const path = await newPage(await setup.newPage());
		await setup.close();
		await page.goto(path);
		const panel = page.locator('#attachments');
		const name = `no-js-${unique()}.txt`;
		await panel
			.locator('input[type="file"]')
			.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('plain form') });
		await panel.getByRole('button', { name: 'Upload' }).click();
		await expect(page).toHaveURL(`${path}?uploaded=1#attachments`);
		await expect(panel.getByText('File uploaded.')).toBeVisible();
		await expect(panel.getByRole('link', { name })).toBeVisible();
		await expectNoHorizontalOverflow(page);
		await expectTouchTargets(page, viewport!.width);

		await panel.locator('summary', { hasText: 'Delete' }).click();
		await expect(panel.getByText('This cannot be undone.')).toBeVisible();
		await expectNoHorizontalOverflow(page);
		await panel.getByRole('button', { name: 'Delete file' }).click();
		await expect(page).toHaveURL(`${path}?deleted=1#attachments`);
		await expect(panel.getByText('File deleted.')).toBeVisible();
		await expect(panel.getByText('No attachments')).toBeVisible();
	});
});
