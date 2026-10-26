import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { emulateSafeAreas } from './helpers';
import { SEED_PASSWORD, SEED_USERS } from '../scripts/seed-data';

/**
 * Screenshots, not a check: skipped unless RUBY_SCREENSHOTS=1.
 *
 *   RUBY_SCREENSHOTS=1 RUBY_E2E_PORT=4451 npx playwright test e2e/screenshots.spec.ts --project=iphone-402
 *   RUBY_SCREENSHOTS=1 RUBY_E2E_PORT=4451 npx playwright test e2e/screenshots.spec.ts --project=desktop
 *
 * 1. RB-10 design review screenshots (docs/design/screenshots/): home, a project board, a task, a knowledge-base
 *    page, people, the org chart, time off, the team calendar, What's new, admin users and sign-in, in light and
 *    dark, at 402 × 874 and 1280 × 800 (CSS pixels).
 * 2. The README's source screenshots (docs/readme/src/shots/), taken at 2× density for `npm run readme:images`:
 *    the screens the images use, with the iPhone's safe areas emulated on the phone.
 *
 * The content is fictional (`@example.test` accounts, made-up names) and created through the UI on the first run:
 * a project with labelled tasks on every board column, a milestone and a checklist, a knowledge-base page, and two
 * leave requests by the seeded member (one approved by the seeded admin, one pending).
 */

test.skip(!process.env.RUBY_SCREENSHOTS, 'screenshots only on request (RUBY_SCREENSHOTS=1)');
test.describe.configure({ mode: 'serial' });

const KEY = 'DSGN';
const OUT = 'docs/design/screenshots';
const README_OUT = 'docs/readme/src/shots';
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

const LABELS: [string, string][] = [
	['Bug', 'red'],
	['Ops', 'orange'],
	['Hardware', 'green'],
	['Docs', 'blue'],
	['Design', 'purple']
];

/** Title, status, priority, assignee and labels. Tasks 1 to 5 keep their numbers from the first version. */
const TASKS: [string, string, string, string, string[]][] = [
	[
		'Draft the quarterly review of the warehouse routing rules',
		'todo',
		'high',
		'Ada Admin',
		['Docs']
	],
	['Tidy the label printer settings', 'todo', 'low', 'Max Member', ['Hardware']],
	[
		'Move the stock count to the new scanner app',
		'in_progress',
		'urgent',
		'Ada Admin',
		['Ops', 'Hardware']
	],
	[
		'Write the onboarding notes for the night shift',
		'in_progress',
		'medium',
		'Max Member',
		['Docs']
	],
	['Replace the loading dock sign', 'done', 'medium', 'Ada Admin', ['Hardware']],
	[
		'Fix the scan that fails on damaged barcodes',
		'in_review',
		'high',
		'Max Member',
		['Bug', 'Ops']
	],
	['Sketch the new pick list layout', 'backlog', 'medium', 'Max Member', ['Design']],
	['Check the scale calibration log', 'in_review', 'low', 'Ada Admin', ['Ops']]
];

const MILESTONE = 'Scanner rollout';
const STEPS = ['Export the current counts', 'Train the day shift', 'Retire the old handhelds'];

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A Monday at least a week ahead whose next ten days stay in the same month, so one calendar month shows both. */
function leaveWeek(): { monday: string; wednesday: string; nextMonday: string; month: string } {
	const today = Date.parse(
		`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date())}T00:00:00Z`
	);
	for (let d = today + 7 * DAY; ; d += DAY) {
		const date = new Date(d);
		if (date.getUTCDay() === 1 && new Date(d + 10 * DAY).getUTCMonth() === date.getUTCMonth())
			return {
				monday: iso(d),
				wednesday: iso(d + 2 * DAY),
				nextMonday: iso(d + 7 * DAY),
				month: iso(d).slice(0, 7)
			};
	}
}

const settle = async (page: Page) => {
	await page.waitForLoadState('networkidle');
	await page.evaluate(() => document.fonts.ready);
};

/** A signed-out context of this project's device, signed in as the seeded member. */
async function memberPage(
	browser: Browser,
	info: TestInfo,
	extra: { colorScheme?: 'light' | 'dark'; deviceScaleFactor?: number } = {}
): Promise<Page> {
	const context = await browser.newContext({
		...info.project.use,
		...extra,
		storageState: { cookies: [], origins: [] }
	});
	const page = await context.newPage();
	await page.goto(new URL('/login', info.project.use.baseURL ?? 'http://localhost').href);
	await page.getByLabel('E-mail').fill(SEED_USERS[1].email);
	await page.getByLabel('Password').fill(SEED_PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
	return page;
}

async function ensureProject(page: Page) {
	if ((await page.goto(`/projects/${KEY}`))?.status() === 200) return;
	await page.goto('/projects/new');
	await page.getByLabel('Key').fill(KEY);
	await page.getByLabel('Name').fill('Warehouse app');
	await page.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(`/projects/${KEY}`);

	await page.goto(`/projects/${KEY}/settings`);
	await settle(page);
	const labels = page.getByRole('region', { name: 'Labels' });
	for (const [name, colour] of LABELS) {
		// The add form comes after each existing label's edit form, which has the same fields.
		await labels.getByLabel('Name').last().fill(name);
		await labels.getByLabel('Colour').last().selectOption(colour);
		await labels.getByRole('button', { name: 'Add label' }).click();
		await expect(labels.getByText(`Label “${name}” added.`)).toBeVisible();
	}
	const milestones = page.getByRole('region', { name: 'Milestones' });
	await milestones.getByLabel('Name').fill(MILESTONE);
	await milestones.getByRole('button', { name: 'Add milestone' }).click();
	await expect(milestones.getByText(`Milestone “${MILESTONE}” added.`)).toBeVisible();

	for (const [title, status, priority, assignee, names] of TASKS) {
		await page.goto(`/projects/${KEY}/tasks/new`);
		await settle(page);
		await page.getByLabel('Title').fill(title);
		await page.getByLabel('Status').selectOption(status);
		await page.getByLabel('Priority').selectOption(priority);
		await page.getByLabel('Assignee').selectOption({ label: assignee });
		await page.getByRole('button', { name: 'Create task' }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${KEY}/tasks/\\d+$`));
		await settle(page);
		await page.getByText('Change labels').click();
		for (const name of names) await page.getByRole('checkbox', { name, exact: true }).check();
		await Promise.all([
			page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('labelsSet')),
			page.getByRole('button', { name: 'Save labels' }).click()
		]);
	}

	await page.goto(`/projects/${KEY}/tasks/3`);
	await settle(page);
	const checklist = page.getByRole('region', { name: 'Checklist' });
	for (const step of STEPS) {
		await checklist.getByLabel('New step').fill(step);
		await checklist.getByRole('button', { name: 'Add step' }).click();
		await expect(checklist.getByRole('button', { name: `Not done: ${step}` })).toBeVisible();
	}
	await checklist.getByRole('button', { name: `Not done: ${STEPS[0]}` }).click();
	await expect(checklist.getByRole('button', { name: `Done: ${STEPS[0]}` })).toBeVisible();
	// A <select> picked before hydration can be reset (projects.spec QA F1): retry until the patch is confirmed.
	await expect(async () => {
		await page.getByLabel('Milestone').selectOption({ label: MILESTONE });
		await expect(page.getByRole('link', { name: 'Open milestone' })).toBeVisible({
			timeout: 3_000
		});
	}).toPass({ timeout: 20_000 });
}

async function ensureKbPage(page: Page): Promise<string> {
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
	return (await link.getAttribute('href')) ?? '/kb';
}

/** Two requests by the seeded member: Monday to Wednesday (approved by the seeded admin, who is HR) and a pending one. */
async function ensureLeave(page: Page, browser: Browser, info: TestInfo) {
	const { monday, wednesday, nextMonday } = leaveWeek();
	const member = await memberPage(browser, info);
	await member.goto('/time-off');
	await settle(member);
	const mine = member.getByRole('list', { name: 'My requests' });
	if ((await mine.count()) === 0 || (await mine.getByText(monday).count()) === 0) {
		for (const [start, end] of [
			[monday, wednesday],
			[nextMonday, '']
		] as const) {
			await member.goto('/time-off');
			await settle(member);
			await member.getByLabel('Leave type').selectOption({ label: 'Annual' });
			await member.getByLabel('Start date').fill(start);
			await member.getByLabel('End date').fill(end);
			await member.getByRole('button', { name: 'Submit request' }).click();
			await expect(member.getByText(/^Leave requested: /)).toBeVisible();
		}
		await page.goto('/time-off/approvals');
		await settle(page);
		const item = page
			.getByRole('list', { name: 'Requests to decide' })
			.getByRole('listitem')
			.filter({ hasText: monday });
		await item.getByRole('button', { name: 'Approve' }).click();
		await expect(page.getByText('Request approved.')).toBeVisible();
	}
	await member.context().close();
}

async function ensureContent(
	page: Page,
	browser: Browser,
	info: TestInfo
): Promise<{ task: string; kb: string; calendar: string }> {
	await ensureProject(page);
	const kb = await ensureKbPage(page);
	await ensureLeave(page, browser, info);
	return {
		task: `/projects/${KEY}/tasks/3`,
		kb,
		calendar: `/time-off/calendar?month=${leaveWeek().month}`
	};
}

/** iPhone 17 Pro safe areas (Dynamic Island and home indicator); Chromium cannot fake env(). */
const IPHONE_INSETS = { top: 62, bottom: 34 };

for (const scheme of ['light', 'dark'] as const) {
	test(`screens in ${scheme}`, async ({ page, browser }, info) => {
		const phone = info.project.name !== 'desktop';
		const size = phone ? '402' : '1280';
		const { task, kb, calendar } = await ensureContent(page, browser, info);
		await page.emulateMedia({ colorScheme: scheme });
		const shots: [string, string][] = [
			['home', '/'],
			['board', `/projects/${KEY}?view=board`],
			['task', task],
			['kb-page', kb],
			['people', '/people'],
			['org-chart', '/people/org'],
			['time-off-calendar', calendar],
			['releases', '/releases'],
			['admin-users', '/admin/users']
		];
		for (const [name, path] of shots) {
			await page.goto(path);
			await settle(page);
			await page.screenshot({ path: `${OUT}/${name}-${size}-${scheme}.png`, scale: 'css' });
		}

		const member = await memberPage(browser, info, { colorScheme: scheme });
		await member.goto('/time-off');
		await settle(member);
		await member.screenshot({ path: `${OUT}/time-off-${size}-${scheme}.png`, scale: 'css' });
		await member.context().close();

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

		// The README's sources (only those the images use), at 2× density, 1440 px wide on the desktop so more board
		// columns show.
		const all: [string, string, 'light' | 'dark'][] = phone
			? [
					['home', '/', 'light'],
					['board', `/projects/${KEY}?view=board`, 'dark'],
					['time-off', '/time-off', 'light'],
					['releases', '/releases', 'dark']
				]
			: [
					['board', `/projects/${KEY}?view=board`, 'light'],
					['board', `/projects/${KEY}?view=board`, 'dark'],
					['kb-page', kb, 'light'],
					['kb-page', kb, 'dark'],
					['people', '/people', 'light'],
					['org-chart', '/people/org', 'dark']
				];
		const readme = all.filter(([, , only]) => only === scheme);
		const hiDpi = { colorScheme: scheme, deviceScaleFactor: 2 } as const;
		const admin = await browser.newContext({
			...info.project.use,
			...hiDpi,
			...(phone ? {} : { viewport: { width: 1440, height: 900 } })
		});
		const adminPage = await admin.newPage();
		const memberHiDpi = await memberPage(browser, info, hiDpi);
		for (const [name, path] of readme) {
			// Time off is shown from the member's side: their balance and both requests.
			const target = name === 'time-off' ? memberHiDpi : adminPage;
			await target.goto(path);
			await settle(target);
			if (phone) await emulateSafeAreas(target, IPHONE_INSETS);
			await target.screenshot({
				path: `${README_OUT}/${name}-${phone ? 'phone' : 'desktop'}-${scheme}.png`,
				scale: 'device'
			});
		}
		await memberHiDpi.context().close();
		await admin.close();
	});
}
