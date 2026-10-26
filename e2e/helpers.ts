import { expect, type Page } from '@playwright/test';

/** Where the setup project keeps the seeded admin's session cookie (gitignored). */
export const STORAGE_STATE = 'e2e/.auth/admin.json';

/**
 * The page never scrolls sideways: its content fits the viewport width. On an emulated phone, content wider than the
 * screen widens the layout viewport itself (innerWidth grows with scrollWidth), so the layout viewport must also still
 * be the device width.
 */
export async function expectNoHorizontalOverflow(page: Page) {
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(scrollWidth, `scrollWidth ${scrollWidth} > innerWidth ${innerWidth}`).toBeLessThanOrEqual(
		innerWidth
	);
	const width = page.viewportSize()?.width;
	if (width)
		expect(innerWidth, `layout viewport ${innerWidth} wider than the screen ${width}`).toBe(width);
}

/** A test's own notch: the shell reads only these variables (app.css), and Chromium cannot fake env(). */
export async function emulateSafeAreas(
	page: Page,
	insets: { top?: number; right?: number; bottom?: number; left?: number }
) {
	await page.evaluate((i) => {
		const root = document.documentElement.style;
		for (const side of ['top', 'right', 'bottom', 'left'] as const)
			root.setProperty(`--sai-${side}`, `${i[side] ?? 0}px`);
	}, insets);
}
