import { expect, test, type Page } from '@playwright/test';

/**
 * RB-06 QA D1: on a slow phone a person can change a form control before the page has hydrated. Hydration must keep
 * that choice instead of putting the server-rendered value back. The app's scripts are held back until the controls
 * are changed, then released; the page counts as hydrated once LocalTime has replaced the server's UTC date with the
 * local form (it does that in onMount).
 */

/** Holds every app script until the returned function is called. */
async function holdScripts(page: Page): Promise<() => void> {
	let release!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/_app/immutable/**/*.js', async (route) => {
		await released;
		await route.continue();
	});
	return release;
}

test('choices made before hydration survive it (kit Select and TextField)', async ({ page }) => {
	const release = await holdScripts(page);
	await page.goto('/admin/users', { waitUntil: 'domcontentloaded' });

	const invite = page.locator('form[action="?/invite"]');
	const role = invite.getByLabel('Role');
	const email = invite.getByLabel('E-mail');
	await expect(role).toHaveValue('member');
	await role.selectOption('admin');
	await email.fill('pre.hydration@example.test');

	// The first user's last sign-in is a LocalTime: the server writes 2026-10-26, the hydrated page a local date.
	const time = page.locator('main time').first();
	await expect(time).toHaveText(/^\d{4}-\d{2}-\d{2}/);
	release();
	await expect(time).not.toHaveText(/^\d{4}-\d{2}-\d{2}/);

	await expect(role).toHaveValue('admin');
	await expect(email).toHaveValue('pre.hydration@example.test');
});
