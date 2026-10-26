import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { SEED_PASSWORD, SEED_USERS } from '../scripts/seed-data';
import { expectNoHorizontalOverflow } from './helpers';

/**
 * RB-03 at every project size (iPhone 17 / 17 Pro / 18 Pro 402 × 874, 440 × 956, 360 px, desktop): comments on a
 * task and on a page, the @mention picker, edit and delete, a comment without JavaScript, the notifications page and
 * the unread badge. No sideways page scroll; 44 px touch targets on phones. Every test writes its own task or page
 * (the projects run in parallel against one local database); the admin is signed in, the member signs in in a
 * second browser context to notify the admin.
 */

const [ADMIN, MEMBER] = SEED_USERS;
const KEYS: Record<string, string> = {
	'iphone-402': 'CMTA',
	'iphone-440': 'CMTB',
	'phone-360': 'CMTC',
	desktop: 'CMTD'
};
const keyOf = (info: { project: { name: string }; repeatEachIndex: number }) =>
	`${KEYS[info.project.name] ?? 'CMTX'}${info.repeatEachIndex || ''}`;
const isPhone = (width: number) => width < 768;
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** On a touch screen every visible control inside `scope` is at least 44 px tall. */
async function expectTouchTargets(page: Page, scope: string) {
	if (!isPhone(page.viewportSize()!.width)) return;
	const small = await page
		.locator(scope)
		.locator('button, .btn, summary, select, input:not([type="hidden"]), textarea, [role="option"]')
		.evaluateAll((els) =>
			els
				.filter((el) => (el as HTMLElement).offsetParent !== null)
				.map((el) => ({ el: el.outerHTML.slice(0, 80), h: el.getBoundingClientRect().height }))
				.filter((x) => x.h < 44)
		);
	expect(small).toEqual([]);
}

/** A task in the viewport's own project (the project is made on the first run only). */
async function newTask(page: Page, key: string, title: string): Promise<string> {
	const response = await page.goto(`/projects/${key}`);
	if (response?.status() !== 200) {
		await page.goto('/projects/new');
		await page.getByLabel('Key').fill(key);
		await page.getByLabel('Name').fill(`Comments check ${key}`);
		await page.getByRole('button', { name: 'Create project' }).click();
		await expect(page).toHaveURL(`/projects/${key}`);
	}
	await page.goto(`/projects/${key}/tasks/new`);
	await page.getByLabel('Title').fill(title);
	await page.getByRole('button', { name: 'Create task' }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${key}/tasks/\\d+$`));
	return new URL(page.url()).pathname;
}

/**
 * Clicks a button after centring it: without JavaScript, Playwright's own scroll can leave a button at the
 * viewport's bottom edge, under the fixed phone tab bar (a person scrolls past it; the page has room below).
 */
async function press(locator: Locator) {
	await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
	await locator.click();
}

async function newPage(page: Page, title: string): Promise<string> {
	await page.goto('/kb/new');
	await page.getByLabel('Title', { exact: true }).fill(title);
	await page.getByLabel('Body', { exact: true }).fill('A fictional page to discuss.');
	await press(page.getByRole('button', { name: 'Create page' }));
	await page.waitForURL(/\/kb\/[0-9a-f-]{36}\?notice=created$/);
	return new URL(page.url()).pathname;
}

/** Posts `body` as the comment form's text and waits for the redirect to the new comment. */
async function postComment(page: Page, body: string) {
	await page.getByLabel('Add a comment', { exact: true }).fill(body);
	await page.getByRole('button', { name: 'Comment', exact: true }).click();
	await page.waitForURL(/#comment-[0-9a-f-]{36}$/);
}

test('a task comment with the mention picker, then edit and delete', async ({ page }, info) => {
	const path = await newTask(page, keyOf(info), `Discuss ${unique()}`);
	const thread = page.locator('#comments');
	await expect(thread.getByText('No comments yet — start the discussion.')).toBeVisible();
	await expectNoHorizontalOverflow(page);

	// The picker: @ plus letters lists people; arrows and Enter insert the token.
	const box = page.getByLabel('Add a comment', { exact: true });
	await box.click();
	await page.keyboard.type('Thanks @Ma');
	const list = page.getByRole('listbox', { name: 'People to mention' });
	await expect(list.getByRole('option', { name: MEMBER.name })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, '#comments');
	await page.keyboard.press('Enter');
	await expect(list).toBeHidden();
	await expect(box).toHaveValue(`Thanks @[${MEMBER.name}](user:${MEMBER.id}) `);
	await page.keyboard.type('for the **review**');
	await page.getByRole('button', { name: 'Preview' }).first().click();
	await expect(thread.locator('.preview strong')).toHaveText('review');
	await page.getByRole('button', { name: 'Write' }).first().click();
	await page.getByRole('button', { name: 'Comment', exact: true }).click();
	await page.waitForURL(new RegExp(`${path}#comment-[0-9a-f-]{36}$`));

	const comment = thread.locator('li.comment').first();
	await expect(comment.locator('.mention')).toHaveText(`@${MEMBER.name}`);
	await expect(comment.locator('strong')).toHaveText('review');
	await expect(box).toHaveValue('');
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, '#comments');

	// Edit in place.
	await comment.getByRole('link', { name: 'Edit' }).click();
	const edit = page.getByLabel('Edit comment', { exact: true });
	await expect(edit).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await edit.fill('Changed my mind.');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(comment.getByText('Changed my mind.')).toBeVisible();
	await expect(comment.getByText('edited')).toBeVisible();

	// Delete asks first, then the comment is gone.
	page.once('dialog', (dialog) => dialog.accept());
	await comment.getByRole('button', { name: 'Delete' }).click();
	await expect(thread.getByText('No comments yet — start the discussion.')).toBeVisible();
});

test('a page comment fits the screen, long words and code included', async ({ page }) => {
	await newPage(page, `Comment page ${unique()}`);
	await postComment(
		page,
		[
			'A-very-long-unbroken-identifier-that-should-wrap-instead-of-widening-the-page-at-any-width.',
			'',
			'```',
			'const line = "a code line far wider than any phone screen, which scrolls inside its own box";',
			'```'
		].join('\n')
	);
	const thread = page.locator('#comments');
	await expect(thread.locator('li.comment')).toHaveCount(1);
	await expect(thread.locator('h2')).toContainText('1');
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, '#comments');
});

async function signInAsMember(browser: Browser, viewport: { width: number; height: number }) {
	const context = await browser.newContext({ viewport, storageState: undefined });
	const page = await context.newPage();
	await page.goto('/login');
	await page.getByLabel('E-mail').fill(MEMBER.email);
	await page.getByLabel('Password').fill(SEED_PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
	return { context, page };
}

test('a mention reaches the notifications page and the badge; mark read', async ({
	page,
	browser
}) => {
	const title = `Inbox page ${unique()}`;
	const path = await newPage(page, title);

	const member = await signInAsMember(browser, page.viewportSize()!);
	try {
		await member.page.goto(path);
		await postComment(member.page, `Have a look @[${ADMIN.name}](user:${ADMIN.id}) please`);
	} finally {
		await member.context.close();
	}

	// The badge: in the top bar on phones, in the sidebar on wide screens.
	await page.goto('/');
	const badge = isPhone(page.viewportSize()!.width)
		? page.locator('.topbar .dot-count')
		: page.locator('.sidebar .side-actions .dot-count');
	await expect(badge).toHaveText(/^([1-9][0-9]?|99\+)$/);

	await page.goto('/notifications?filter=unread');
	await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
	const row = page.locator('li.row').filter({ hasText: title });
	await expect(row).toContainText(`${MEMBER.name} mentioned you in a comment on ${title}`);
	await expect(row).toContainText(`Have a look @${ADMIN.name} please`);
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, 'main');

	await row.getByRole('button', { name: 'Mark read' }).click();
	await expect(page.locator('li.row').filter({ hasText: title })).toHaveCount(0);
	await page.goto('/notifications');
	const read = page.locator('li.row').filter({ hasText: title });
	await expect(read).toBeVisible();
	await expect(read).not.toHaveClass(/unread/);
	await expect(read.getByRole('button', { name: 'Mark read' })).toHaveCount(0);

	// The link goes to the comment.
	await read.getByRole('link', { name: title }).click();
	await expect(page).toHaveURL(new RegExp(`${path}#comment-[0-9a-f-]{36}$`));
});

/**
 * Phones: focusing each form's submit button from the top of the page (what Tab or a validation focus does) scrolls
 * it clear of the fixed tab bar (QA F1: `scroll-padding-bottom` in app.css).
 */
async function expectFocusedSubmitsClearTabBar(page: Page) {
	const path = await newPage(page, `Focus ${unique()}`);
	for (const [url, name] of [
		[path, 'Comment'],
		['/kb/new', 'Create page'],
		[`${path}/edit`, 'Save']
	] as const) {
		await page.goto(url);
		const button = page.getByRole('button', { name, exact: true }).last();
		await page.evaluate(() => window.scrollTo(0, 0));
		await button.focus();
		const { bottom, barTop } = await button.evaluate((el) => ({
			bottom: el.getBoundingClientRect().bottom,
			barTop: document.querySelector('.tabbar')!.getBoundingClientRect().top
		}));
		expect(
			bottom,
			`${name} on ${url}: button bottom ${bottom} > tab bar top ${barTop}`
		).toBeLessThanOrEqual(barTop);
	}
}

test('phones: a focused submit button is never under the tab bar', async ({ page }) => {
	test.skip(!isPhone(page.viewportSize()!.width), 'phones');
	await expectFocusedSubmitsClearTabBar(page);
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('a comment posts and a refusal keeps the text', async ({ page }) => {
		const path = await newPage(page, `No JS ${unique()}`);
		await page.getByLabel('Add a comment', { exact: true }).fill('   ');
		// `required` stops a blank form in the browser; a whitespace-only body reaches the server.
		await press(page.getByRole('button', { name: 'Comment', exact: true }));
		await expect(page.getByRole('alert')).toHaveText('Write something first.');
		await page.getByLabel('Add a comment', { exact: true }).fill('Posted without scripts.');
		await press(page.getByRole('button', { name: 'Comment', exact: true }));
		await expect(page).toHaveURL(new RegExp(`${path}#comment-[0-9a-f-]{36}$`));
		await expect(page.locator('#comments li.comment')).toContainText('Posted without scripts.');
		await expectNoHorizontalOverflow(page);
	});

	test('phones: a focused submit button is never under the tab bar', async ({ page }) => {
		test.skip(!isPhone(page.viewportSize()!.width), 'phones');
		await expectFocusedSubmitsClearTabBar(page);
	});
});
