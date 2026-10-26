import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers';

/**
 * RB-09 calendar and reminders at iPhone 17 / 17 Pro / 18 Pro (402 × 874), Pro Max (440 × 956), 360 px and desktop:
 * the agenda is the phone default and the month the desktop one, no page scrolls sideways (grids scroll in their own
 * box), tap targets are at least 44 px; create, edit and view an event (private), set reminders, and a reminder
 * delivered by a simulated `ruby-jobs` cron tick showing up in Notifications.
 */

const ZONE = 'Asia/Jakarta';
const isPhone = (width: number) => width < 768;
const box = async (locator: Locator) => {
	const b = await locator.boundingBox();
	if (!b) throw new Error('element has no box');
	return b;
};
/** Team-zone date and time of an instant, as the date and time inputs take them. */
function teamWallClock(at: number): { date: string; time: string } {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: ZONE,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit'
	}).formatToParts(at);
	const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
	return { date: `${p('year')}-${p('month')}-${p('day')}`, time: `${p('hour')}:${p('minute')}` };
}
const unique = (label: string, project: string) =>
	`${label} ${project} ${Math.random().toString(36).slice(2, 7)}`;

/**
 * Opens `url` and waits until the page's scripts have loaded: a field changed before hydration can be reset to its
 * server value by the hydrating component (the RB-05 QA F1 race), which a person never hits but a test would.
 */
async function open(page: Page, url: string) {
	await page.goto(url);
	await page.waitForLoadState('networkidle');
}

async function expectTapTargets(locators: Locator, min = 44) {
	for (const el of await locators.all()) {
		if (!(await el.isVisible())) continue;
		const b = await box(el);
		expect(b.height, 'tap target height').toBeGreaterThanOrEqual(min - 0.5);
		expect(b.width, 'tap target width').toBeGreaterThanOrEqual(min - 0.5);
	}
}

test.describe('calendar views', () => {
	test('default: agenda on phones, month on desktop; nothing scrolls sideways', async ({
		page,
		viewport
	}) => {
		await page.goto('/calendar');
		await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible();
		const month = page.locator('section.grid-block');
		const agenda = page.locator('section.agenda-block');
		if (isPhone(viewport!.width)) {
			await expect(agenda).toBeVisible();
			await expect(month).toBeHidden();
		} else {
			await expect(month).toBeVisible();
			await expect(agenda).toBeHidden();
		}
		await expectNoHorizontalOverflow(page);
		// 44 px targets on coarse pointers (the phone projects); a desktop mouse gets Kumo's compact controls.
		if (isPhone(viewport!.width)) {
			await expectTapTargets(page.locator('nav.toolbar .step'));
			await expectTapTargets(page.getByRole('navigation', { name: 'View' }).getByRole('link'));
		}
	});

	for (const view of ['month', 'week', 'agenda'] as const)
		test(`${view} view fits and its targets are 44 px`, async ({ page, viewport }) => {
			await page.goto(`/calendar?view=${view}`);
			await expect(
				page.getByRole('navigation', { name: 'View' }).locator('a[aria-current="page"]')
			).toHaveText(view[0]!.toUpperCase() + view.slice(1));
			await expectNoHorizontalOverflow(page);
			if (view === 'month') {
				await expect(page.locator('.cells > li')).toHaveCount(42);
				if (isPhone(viewport!.width)) await expectTapTargets(page.locator('.cell .day-link'));
			}
			if (view === 'week') {
				if (isPhone(viewport!.width)) {
					await expect(page.locator('.strip-day')).toHaveCount(7);
					await expectTapTargets(page.locator('.strip-day'));
				} else await expect(page.locator('.week-cols .col')).toHaveCount(7);
			}
			if (view === 'agenda')
				await expect(page.getByRole('link', { name: 'Load next 14 days' })).toBeVisible();
			// The filters disclosure works without JavaScript and keeps the page width.
			await page.locator('details.filters summary').click();
			await expect(page.getByRole('button', { name: 'Apply' })).toBeVisible();
			await expectNoHorizontalOverflow(page);
		});
});

async function createEvent(page: Page, title: string, date: string, privateEvent: boolean) {
	await open(page, `/calendar/events/new?date=${date}`);
	await expect(page.getByRole('heading', { level: 1, name: 'New event' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	const size = await page
		.getByLabel('Title')
		.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
	expect(size).toBeGreaterThanOrEqual(16);
	await page.getByLabel('Title').fill(title);
	await page.getByLabel('Start time (WIB)').fill('14:00');
	await page.getByLabel('End time (WIB)').fill('15:30');
	await page.getByLabel('Location').fill('Room 2');
	if (privateEvent)
		await page.getByLabel('Who can see it').selectOption({ label: 'Private: me and attendees' });
	await page.getByRole('button', { name: 'Create event' }).click();
	await expect(page).toHaveURL(/\/calendar\/events\/[0-9a-f-]{36}\?created=1$/);
	await expect(page.getByText('Event created.')).toBeVisible();
}

test.describe('events and reminders', () => {
	test('create a private event, see it on the calendar, edit it', async ({ page }, info) => {
		const tomorrow = teamWallClock(Date.now() + 86_400_000).date;
		const title = unique('Planning', info.project.name);
		await createEvent(page, title, tomorrow, true);
		await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
		await expect(page.getByText('Private', { exact: true }).first()).toBeVisible();
		await expect(page.getByText(/14:00–15:30 WIB/)).toBeVisible();
		await expectNoHorizontalOverflow(page);

		await page.goto(`/calendar?view=agenda&date=${tomorrow}`);
		const line = page.locator('a.line', { hasText: title });
		await expect(line).toBeVisible();
		await expect(line).toContainText('Private');
		expect((await box(line)).height).toBeGreaterThanOrEqual(44);
		await expectNoHorizontalOverflow(page);

		await line.click();
		await page.getByRole('link', { name: 'Edit' }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Edit event' })).toBeVisible();
		await expectNoHorizontalOverflow(page);
		await page.getByLabel('Title').fill(`${title} (moved)`);
		await page.getByLabel('Start time (WIB)').fill('16:00');
		await page.getByLabel('End time (WIB)').fill('16:30');
		await page.getByRole('button', { name: 'Save event' }).click();
		await expect(page.getByText('Event saved.')).toBeVisible();
		await expect(page.getByRole('heading', { level: 1, name: `${title} (moved)` })).toBeVisible();
		await expect(page.getByText(/16:00–16:30 WIB/)).toBeVisible();
	});

	test('set a reminder on an event and a personal one', async ({ page }, info) => {
		const tomorrow = teamWallClock(Date.now() + 86_400_000).date;
		await createEvent(page, unique('Review', info.project.name), tomorrow, false);
		const panel = page.locator('.reminders');
		await panel.getByLabel('Remind me').selectOption({ label: '1 hour before' });
		await panel.getByRole('button', { name: 'Add reminder' }).click();
		await expect(panel.getByText('Reminder set.')).toBeVisible();
		await expect(panel.locator('.list .label', { hasText: '1 hour before' })).toBeVisible();
		await expect(panel.getByText(/Tomorrow 13:00 WIB/)).toBeVisible();
		// Touch targets are 44 px on coarse pointers (the phone projects); a desktop mouse gets the compact size.
		if (info.project.use.hasTouch)
			await expectTapTargets(panel.getByRole('button', { name: /Remove/ }));
		await expectNoHorizontalOverflow(page);

		await open(page, '/reminders');
		await expect(page.getByRole('heading', { level: 1, name: 'My reminders' })).toBeVisible();
		const note = unique('Call the supplier', info.project.name);
		await page.getByLabel('Remind me to').fill(note);
		await page.getByLabel('Date').fill(tomorrow);
		await page.getByLabel('Time (WIB)').fill('09:00');
		await page.getByRole('button', { name: 'Add reminder' }).click();
		await expect(page.getByText('Reminder set.')).toBeVisible();
		await expect(page.locator('.rows .what', { hasText: note })).toBeVisible();
		await expectNoHorizontalOverflow(page);
	});
});

test.describe('scheduler', () => {
	let jobs: ChildProcess | null = null;
	test.afterEach(() => {
		jobs?.kill('SIGTERM');
		jobs = null;
	});

	test('a reminder appears in Notifications after a simulated cron tick', async ({
		page
	}, info) => {
		test.skip(info.project.name !== 'iphone-402', 'one run is enough: it starts the jobs Worker');
		test.setTimeout(180_000);
		// The time input steps in 5 minutes (the browser refuses anything else): the next 5-minute mark, 2+ minutes out.
		const fireAt = Math.ceil((Date.now() + 2 * 60_000) / 300_000) * 300_000;
		const when = teamWallClock(fireAt);
		const note = unique('Water the plants', info.project.name);
		await open(page, '/reminders');
		await page.getByLabel('Remind me to').fill(note);
		await page.getByLabel('Date').fill(when.date);
		await page.getByLabel('Time (WIB)').fill(when.time);
		await page.getByRole('button', { name: 'Add reminder' }).click();
		await expect(page.getByText('Reminder set.')).toBeVisible();

		// The jobs Worker under `wrangler dev`, on the e2e server's local D1 (same database id).
		const appPort = Number(process.env.RUBY_E2E_PORT ?? 4317);
		// Its own ports (one more pair per --repeat-each copy), clear of the app server's port and inspector.
		const port = appPort + 2 + 2 * info.repeatEachIndex;
		jobs = spawn(
			'npx',
			[
				'wrangler',
				'dev',
				'-c',
				'workers/jobs/wrangler.jsonc',
				'--persist-to',
				'.wrangler/e2e-state',
				'--port',
				String(port),
				'--ip',
				'127.0.0.1',
				'--inspector-port',
				String(port + 1000)
			],
			{ stdio: 'ignore', env: { ...process.env, CI: 'true' } }
		);
		const base = `http://127.0.0.1:${port}`;
		await expect
			.poll(async () => (await fetch(base).catch(() => null))?.status ?? 0, { timeout: 90_000 })
			.toBe(404);
		// One tick at a simulated minute after the fire time, through Miniflare's trigger route (wrangler's own
		// `/__scheduled` ignores `time`). The Worker never runs earlier than its own clock.
		// Two workerd processes share the local SQLite file here (never in production), so a tick can meet a busy
		// database; dispatch is idempotent, so it is retried until it reports success.
		await expect
			.poll(
				async () =>
					(await fetch(`${base}/cdn-cgi/local/scheduled?cron=*+*+*+*+*&time=${fireAt + 60_000}`))
						.status,
				{ timeout: 30_000 }
			)
			.toBe(200);

		await page.goto('/notifications');
		const row = page.locator('.list li', { hasText: note });
		await expect(row).toBeVisible();
		await expect(row).toContainText('Reminder:');
		await expectNoHorizontalOverflow(page);
		await page.goto('/reminders');
		await expect(page.locator('section', { hasText: 'History' }).getByText(note)).toBeVisible();
	});
});
