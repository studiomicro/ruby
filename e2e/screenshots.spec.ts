import { expect, test, type Page } from '@playwright/test';

/**
 * RB-10 design review screenshots (docs/design/screenshots/), not a check: skipped unless RUBY_SCREENSHOTS=1.
 *
 *   RUBY_SCREENSHOTS=1 RUBY_E2E_PORT=4451 npx playwright test e2e/screenshots.spec.ts --project=iphone-402 --project=desktop
 *
 * Home, a project board, a task, a knowledge-base page, people, admin users and sign-in, in light and dark, at
 * 402 × 874 and 1280 × 800. The content is fictional and created through the UI on the first run.
 */

test.skip(!process.env.RUBY_SCREENSHOTS, 'screenshots only on request (RUBY_SCREENSHOTS=1)');
test.describe.configure({ mode: 'serial' });

const KEY = 'DSGN';
const OUT = 'docs/design/screenshots';
const PAGE_TITLE = 'Release checklist for the warehouse app';
const PAGE_BODY = [
	'Everything the team checks before a release goes out.',
	'',
	'## Before the release',
	'',
	'- Run the **full test suite** and the layout checks.',
	'- Read the change log aloud at stand-up.',
	'- Confirm the [runbook](https://example.test/runbook) is current.',
	'',
	'> Releases go out on Tuesdays and Thursdays, never on a Friday.',
	'',
	'```sh',
	'npm run gates',
	'```',
	'',
	'| Step | Owner | When |',
	'| --- | --- | --- |',
	'| Freeze | Ada Admin | Monday |',
	'| Ship | Max Member | Tuesday |'
].join('\n');

const TASKS: [string, string, string][] = [
	['Draft the quarterly review of the warehouse routing rules', 'todo', 'high'],
	['Tidy the label printer settings', 'todo', 'low'],
	['Move the stock count to the new scanner app', 'in_progress', 'urgent'],
	['Write the onboarding notes for the night shift', 'in_progress', 'medium'],
	['Replace the loading dock sign', 'done', 'medium']
];

async function ensureContent(page: Page): Promise<{ task: string; kb: string }> {
	if ((await page.goto(`/projects/${KEY}`))?.status() !== 200) {
		await page.goto('/projects/new');
		await page.getByLabel('Key').fill(KEY);
		await page.getByLabel('Name').fill('Warehouse app');
		await page.getByRole('button', { name: 'Create project' }).click();
		await expect(page).toHaveURL(`/projects/${KEY}`);
		for (const [title, status, priority] of TASKS) {
			await page.goto(`/projects/${KEY}/tasks/new`);
			await page.getByLabel('Title').fill(title);
			await page.getByLabel('Status').selectOption(status);
			await page.getByLabel('Priority').selectOption(priority);
			await page.getByLabel('Assignee').selectOption({ label: 'Ada Admin' });
			await page.getByRole('button', { name: 'Create task' }).click();
			await expect(page).toHaveURL(new RegExp(`/projects/${KEY}/tasks/\\d+$`));
		}
	}
	await page.goto('/kb');
	let link = page.getByRole('link', { name: PAGE_TITLE }).first();
	if ((await link.count()) === 0) {
		await page.goto('/kb/new');
		await page.getByLabel('Title', { exact: true }).fill(PAGE_TITLE);
		await page.getByLabel('Body', { exact: true }).fill(PAGE_BODY);
		await page.getByRole('button', { name: 'Create page' }).click();
		await page.waitForURL(/\/kb\/[0-9a-f-]{36}\?notice=created$/);
		await page.goto('/kb');
		link = page.getByRole('link', { name: PAGE_TITLE }).first();
	}
	const kb = (await link.getAttribute('href')) ?? '/kb';
	return { task: `/projects/${KEY}/tasks/3`, kb };
}

const settle = async (page: Page) => {
	await page.waitForLoadState('networkidle');
	await page.evaluate(() => document.fonts.ready);
};

for (const scheme of ['light', 'dark'] as const) {
	test(`screens in ${scheme}`, async ({ page, browser }, info) => {
		const size = info.project.name === 'desktop' ? '1280' : '402';
		const { task, kb } = await ensureContent(page);
		await page.emulateMedia({ colorScheme: scheme });
		const shots: [string, string][] = [
			['home', '/'],
			['board', `/projects/${KEY}?view=board`],
			['task', task],
			['kb-page', kb],
			['people', '/people'],
			['admin-users', '/admin/users']
		];
		for (const [name, path] of shots) {
			await page.goto(path);
			await settle(page);
			await page.screenshot({ path: `${OUT}/${name}-${size}-${scheme}.png`, scale: 'css' });
		}
		const signedOut = await browser.newContext({
			...info.project.use,
			storageState: { cookies: [], origins: [] },
			colorScheme: scheme
		});
		const login = await signedOut.newPage();
		await login.goto(new URL('/login', page.url()).href);
		await settle(login);
		await login.screenshot({ path: `${OUT}/login-${size}-${scheme}.png`, scale: 'css' });
		await signedOut.close();
	});
}
