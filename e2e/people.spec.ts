import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers';
import { SEED_EMPLOYEES } from '../scripts/seed-data';

/**
 * RB-05 people pages at every project size, signed in as the seeded admin (also HR in the seed): directory, profile,
 * HR edit, an audited reveal and the org chart. No sideways page scroll; the org chart scrolls inside its own box;
 * 44 px touch targets on phones. Tests that write create their own employee (projects run in parallel).
 */

const isPhone = (width: number) => width < 768;
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const MAX_MEMBER = SEED_EMPLOYEES[2][0];

/** On a touch screen every visible control in the main column is at least 44 px tall (checkboxes: their label). */
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

async function createEmployee(page: Page, name: string): Promise<string> {
	await page.goto('/people/new');
	await page.getByLabel('Full name').fill(name);
	await page
		.getByLabel('Job title')
		.fill('Fictional tester with a rather long job title for phones');
	await page.getByLabel('Department').fill('Quality');
	await page.getByRole('button', { name: 'Create employee' }).click();
	await page.waitForURL(/\/people\/[0-9a-f-]{36}\?notice=created$/);
	await expect(page.getByText('Employee created.')).toBeVisible();
	return new URL(page.url()).pathname.split('/')[2]!;
}

test('the directory lists people and fits the screen', async ({ page, viewport }) => {
	await page.goto('/people');
	await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Max Member' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Add employee' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);

	await page.getByRole('searchbox', { name: 'Search people' }).fill('Operations analyst');
	await page.getByRole('button', { name: 'Apply' }).click();
	await expect(page.getByRole('link', { name: 'Eko Teladan' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Max Member' })).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
});

test('the People entry is in the shell navigation', async ({ page, viewport }) => {
	await page.goto('/');
	if (isPhone(viewport!.width)) {
		await page.locator('nav.tabbar summary').click();
		await page.locator('.sheet').getByRole('link', { name: 'People' }).click();
	} else {
		await page.locator('aside nav').getByRole('link', { name: 'People' }).click();
	}
	await expect(page).toHaveURL('/people');
});

test('a profile shows its sections and fits the screen', async ({ page, viewport }) => {
	await page.goto(`/people/${MAX_MEMBER}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Max Member' })).toBeVisible();
	for (const name of ['Contact', 'Employment', 'Personal and sensitive', 'Emergency contacts'])
		await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);
});

test('HR edits, stores a sensitive value and reveals it (masked again on Hide)', async ({
	page,
	viewport
}) => {
	const name = `Fictional Hire ${unique()}`;
	const id = await createEmployee(page, name);
	await expectNoHorizontalOverflow(page);

	await page.goto(`/people/${id}/edit`);
	await expect(page.getByRole('heading', { level: 1, name: `Edit ${name}` })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);
	await page.getByLabel('NIK', { exact: true }).fill('3171 0000 1111 4321');
	await page.getByRole('button', { name: 'Save sensitive details' }).click();
	await expect(page.getByText('Sensitive details saved.')).toBeVisible();
	await expect(page.getByLabel('NIK', { exact: true })).toHaveValue('');

	await page.getByLabel('Work phone').fill('+62 21 5550 1234');
	await page.getByRole('button', { name: 'Save work and employment' }).click();
	await expect(page.getByText('Work and employment saved.')).toBeVisible();

	await page.goto(`/people/${id}`);
	const nik = page.locator('dl > div').filter({ has: page.getByText('NIK', { exact: true }) });
	await expect(nik.getByText('•••• 4321')).toBeVisible();
	await expect(page.locator('main')).not.toContainText('3171000011114321');
	await nik.getByRole('button', { name: 'Reveal NIK' }).click();
	await expect(nik.getByText('3171000011114321')).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await nik.getByRole('button', { name: 'Hide' }).click();
	await expect(nik.getByText('•••• 4321')).toBeVisible();

	// The reveal is in the audit log, by field name only.
	await page.goto('/hr/audit?action=sensitive_view');
	await expect(page.getByText(`Sensitive field revealed · ${name}`).first()).toBeVisible();
	await expect(page.locator('main')).not.toContainText('3171000011114321');
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);
});

test('the org chart nests people and scrolls inside its own box', async ({ page, viewport }) => {
	await page.goto('/people/org');
	await expect(page.getByRole('heading', { level: 1, name: 'Org chart' })).toBeVisible();
	const chart = page.getByRole('region', { name: 'Org chart' });
	await expect(chart.getByRole('link', { name: 'Ada Admin' })).toBeVisible();
	await expect(chart.getByRole('link', { name: 'Max Member' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expectTouchTargets(page, viewport!.width);
	const box = await chart.evaluate((el) => {
		const s = getComputedStyle(el);
		return { overflowX: s.overflowX, right: el.getBoundingClientRect().right };
	});
	expect(box.overflowX).toBe('auto');
	expect(box.right).toBeLessThanOrEqual(viewport!.width);
});
