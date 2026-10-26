import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers';
import { SEED_PASSWORD, SEED_USERS } from '../scripts/seed-data';

/**
 * RB-06 time off at every project size. The seeded admin (Ada Admin, also the only HR) decides; the seeded member
 * (Max Member, whose manager has no account, so HR approves) requests in a second browser context. Projects and
 * tests run in parallel against one server, so every test that writes uses its own week ("slot") of dates and
 * cleans up after itself. No sideways page scroll; the month grid scrolls inside its own box; 44 px touch targets.
 */

const isPhone = (width: number) => width < 768;
const PROJECTS = ['iphone-402', 'iphone-440', 'phone-360', 'desktop'];
const DAY = 86_400_000;

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Today in the team's time zone, as the server sees it. */
const teamToday = () =>
	new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());

/**
 * A Monday at least three weeks ahead from which 20 weeks stay in one calendar year (balance leave cannot cross
 * New Year), so every slot is a valid request date.
 */
function baseMonday(): number {
	const today = Date.parse(`${teamToday()}T00:00:00Z`);
	for (let d = today + 21 * DAY; ; d += DAY) {
		const date = new Date(d);
		if (
			date.getUTCDay() === 1 &&
			date.getUTCFullYear() === new Date(d + 140 * DAY).getUTCFullYear()
		)
			return d;
	}
}

/** The Monday of this test's own week: one per project and test number, never shared. */
function slot(info: TestInfo, n: number): { monday: string; tuesday: string; month: string } {
	const index = Math.max(0, PROJECTS.indexOf(info.project.name));
	const monday = baseMonday() + (index * 5 + n) * 7 * DAY;
	return { monday: iso(monday), tuesday: iso(monday + DAY), month: iso(monday).slice(0, 7) };
}

async function expectTouchTargets(page: Page, width: number) {
	if (!isPhone(width)) return;
	const small = await page
		.locator('main')
		.locator(
			'a.btn, button, .btn, summary, select, input:not([type="hidden"]):not([type="checkbox"]), textarea, label.check'
		)
		.evaluateAll((els) =>
			els
				.filter((el) => (el as HTMLElement).offsetParent !== null)
				.map((el) => ({ el: el.outerHTML.slice(0, 90), h: el.getBoundingClientRect().height }))
				.filter((x) => x.h < 44)
		);
	expect(small).toEqual([]);
}

/** A second context signed in as the seeded member, with this project's device settings. */
async function memberPage(browser: Browser, who: 1 | 2 = 1): Promise<Page> {
	// A test's browser.newContext() inherits the project's options (device, baseURL) and its storage state: start
	// signed out instead of as the admin.
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	await page.goto('/login');
	await page.getByLabel('E-mail').fill(SEED_USERS[who].email);
	await page.getByLabel('Password').fill(SEED_PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
	return page;
}

/**
 * Opens a page and waits until it hydrated: the kit Select resets a choice made before hydration, so the form is
 * filled only afterwards.
 */
async function open(page: Page, path: string) {
	await page.goto(path);
	await page.waitForLoadState('networkidle');
}

async function requestLeave(page: Page, type: string, start: string, end = '') {
	await open(page, '/time-off');
	await page.getByLabel('Leave type').selectOption({ label: type });
	await page.getByLabel('Start date').fill(start);
	await page.getByLabel('End date').fill(end);
	await page.getByRole('button', { name: 'Submit request' }).click();
	await expect(page.getByText(/^Leave requested: /)).toBeVisible();
}

/** The request card of a date range in a list. */
const card = (page: Page, list: string, text: string) =>
	page.getByRole('list', { name: list }).getByRole('listitem').filter({ hasText: text });

test('My time off shows balances, the form and fits the screen', async ({ page, viewport }) => {
	await page.goto('/time-off');
	await expect(page.getByRole('heading', { level: 1, name: 'Time off' })).toBeVisible();
	await expect(page.getByRole('region', { name: /^Annual \d{4}$/ })).toContainText(
		'days available'
	);
	await expect(page.getByRole('heading', { level: 2, name: 'Request leave' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);
});

test('the Time off entry is in the shell navigation', async ({ page, viewport }) => {
	await page.goto('/');
	if (isPhone(viewport!.width)) {
		await page.locator('nav.tabbar summary').click();
		await page
			.locator('.sheet')
			.getByRole('link', { name: /^Time off/ })
			.click();
	} else {
		await page
			.locator('aside nav')
			.getByRole('link', { name: /^Time off/ })
			.click();
	}
	await expect(page).toHaveURL('/time-off');
});

test('a member previews, requests and cancels annual leave; the balance follows', async ({
	browser,
	viewport
}, info) => {
	const { monday, tuesday } = slot(info, 0);
	const member = await memberPage(browser);
	await open(member, '/time-off');
	await member.getByLabel('Leave type').selectOption({ label: 'Annual' });
	await member.getByLabel('Start date').fill(monday);
	await member.getByLabel('End date').fill(tuesday);
	await member.getByRole('button', { name: 'Count days' }).click();
	await expect(member.getByText('This request uses 2 days.')).toBeVisible();
	await expectNoHorizontalOverflow(member);
	await member.getByRole('button', { name: 'Submit request' }).click();
	await expect(member.getByText('Leave requested: 2 days.')).toBeVisible();
	const mine = card(member, 'My requests', `${monday} – ${tuesday}`);
	await expect(mine).toContainText('Pending');
	await expectNoHorizontalOverflow(member);
	await expectTouchTargets(member, viewport!.width);
	await mine.getByRole('button', { name: 'Cancel request' }).click();
	await expect(member.getByText('Request canceled.')).toBeVisible();
	await expect(card(member, 'My requests', `${monday} – ${tuesday}`)).toContainText('Canceled');
	await member.context().close();
});

test('HR approves a request; the calendar shows the name only; the member cancels before the start', async ({
	browser,
	page,
	viewport
}, info) => {
	const { monday, month } = slot(info, 1);
	const member = await memberPage(browser);
	await requestLeave(member, 'Sick', monday);

	await open(page, '/time-off/approvals');
	await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
	const item = card(page, 'Requests to decide', monday).filter({ hasText: 'Max Member' });
	await expect(item).toContainText('Sick');
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);
	await item.getByRole('button', { name: 'Approve' }).click();
	await expect(page.getByText('Request approved.')).toBeVisible();

	await member.goto(`/time-off/calendar?month=${month}`);
	const grid = member.getByRole('region', { name: 'Leave calendar' });
	await expect(grid.getByText('Max Member').first()).toBeVisible();
	await expect(grid).not.toContainText('Sick');
	await expectNoHorizontalOverflow(member);
	await expectTouchTargets(member, viewport!.width);
	const box = await grid.evaluate((el) => ({
		overflowX: getComputedStyle(el).overflowX,
		right: el.getBoundingClientRect().right
	}));
	expect(box.overflowX).toBe('auto');
	expect(box.right).toBeLessThanOrEqual(viewport!.width);

	await open(member, '/time-off');
	const approved = card(member, 'My requests', monday).filter({ hasText: 'Approved' });
	await expect(approved).toContainText('Approved by Ada Admin');
	await approved.getByRole('button', { name: 'Cancel request' }).click();
	await expect(member.getByText('Request canceled.')).toBeVisible();
	await member.context().close();
});

test('HR rejects with a note and the member sees the decision', async ({ browser, page }, info) => {
	const { monday } = slot(info, 2);
	const member = await memberPage(browser);
	await requestLeave(member, 'Unpaid', monday);
	await open(page, '/time-off/approvals');
	const item = card(page, 'Requests to decide', monday).filter({ hasText: 'Max Member' });
	await item.getByLabel('Note (optional)').fill('Fictional busy week');
	await item.getByRole('button', { name: 'Reject' }).click();
	await expect(page.getByText('Request rejected.')).toBeVisible();
	await member.goto('/time-off');
	await expect(card(member, 'My requests', monday)).toContainText(
		'Rejected by Ada Admin: Fictional busy week'
	);
	await expectNoHorizontalOverflow(member);
	await member.context().close();
});

test('the sole HR owner’s request goes to the other admin; no self-approval while one exists', async ({
	browser,
	page,
	viewport
}, info) => {
	const { monday } = slot(info, 4);
	await requestLeave(page, 'Sick', monday);
	// The seed has a second, non-HR admin (Quinn QA): an eligible approver, so self-approval is off (N1).
	await expect(page.getByText('No one else can approve your requests yet')).toHaveCount(0);
	await open(page, '/time-off/approvals');
	await expect(
		card(page, 'Requests to decide', monday).filter({ hasText: 'Ada Admin' })
	).toHaveCount(0);

	const admin = await memberPage(browser, 2);
	await open(admin, '/time-off/approvals');
	const item = card(admin, 'Requests to decide', monday).filter({ hasText: 'Ada Admin' });
	await expect(item).toContainText('Sick');
	await expectNoHorizontalOverflow(admin);
	await expectTouchTargets(admin, viewport!.width);
	await item.getByRole('button', { name: 'Approve' }).click();
	await expect(admin.getByText('Request approved.')).toBeVisible();
	await admin.context().close();

	await open(page, '/time-off');
	const mine = card(page, 'My requests', monday);
	await expect(mine).toContainText('Approved by Quinn QA');
	await expect(mine).not.toContainText('Self-approved');
	await mine.getByRole('button', { name: 'Cancel request' }).click();
	await expect(page.getByText('Request canceled.')).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('HR adds and removes a holiday; settings fit the screen', async ({ page, viewport }, info) => {
	const { monday } = slot(info, 3);
	const year = monday.slice(0, 4);
	await open(page, `/time-off/settings?year=${year}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Time-off settings' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);
	const name = `Fictional Holiday ${info.project.name}`;
	await page.getByLabel('Date', { exact: true }).fill(monday);
	await page.getByLabel('Holiday name').fill(name);
	await page.getByRole('button', { name: 'Add holiday' }).click();
	await expect(page.getByText('Holiday added.')).toBeVisible();
	const row = page
		.getByRole('list', { name: `Holidays ${year}` })
		.getByRole('listitem')
		.filter({ hasText: name });
	await expect(row).toContainText(monday);
	await expectNoHorizontalOverflow(page);
	await row.getByRole('button', { name: `Remove ${name} on ${monday}` }).click();
	await expect(page.getByText('Holiday removed.')).toBeVisible();
	await expect(page.getByText(name)).toHaveCount(0);
});

test('the team page lists balances and requests and fits the screen', async ({
	page,
	viewport
}) => {
	await page.goto('/time-off/team');
	await expect(page.getByRole('heading', { level: 1, name: 'Team time off' })).toBeVisible();
	await expect(page.getByRole('list', { name: /^Balances \d{4}$/ })).toContainText(
		'Max Member · Annual'
	);
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);
	await page.goto('/time-off/calendar');
	await expect(page.getByRole('heading', { level: 1, name: 'Team calendar' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);
});
