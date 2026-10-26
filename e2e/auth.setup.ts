import { expect, test as setup } from '@playwright/test';
import { STORAGE_STATE } from './helpers';
import { SEED_PASSWORD, SEED_USERS } from '../scripts/seed-data';

/** Signs the seeded local admin in once; every project reuses the session cookie. */
setup('sign in as the seeded admin', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('E-mail').fill(SEED_USERS[0].email);
	await page.getByLabel('Password').fill(SEED_PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
	await page.context().storageState({ path: STORAGE_STATE });
});
