import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers';

/**
 * RB-20 Part B motion (docs/features/rb-20-mobile-pwa/MOTION.md), in the `motion` project only: an iPhone 17 size with
 * motion allowed. Each test also runs a "reduce" half (`page.emulateMedia({ reducedMotion: 'reduce' })`) where nothing
 * may move. Script motion is observed by recording every `element.animate()` call (Svelte transitions and the board's
 * FLIP use it); CSS motion through `getAnimations()`. Every test fails on a CSP violation.
 */

// eslint-disable-next-line no-empty-pattern -- Playwright passes testInfo second
test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== 'motion', 'motion project only');
});

declare global {
	interface Window {
		rb20Animations: { target: string; keyframes: string }[];
		rb20Csp: string[];
		rb20Transitions: number;
	}
}

/** Records `element.animate()` calls, view transitions started, and CSP violations. */
async function instrument(page: Page) {
	await page.addInitScript(() => {
		window.rb20Animations = [];
		window.rb20Csp = [];
		window.rb20Transitions = 0;
		const animate = Element.prototype.animate;
		Element.prototype.animate = function (keyframes, options) {
			try {
				window.rb20Animations.push({
					target: this.getAttribute('data-card') ?? this.id ?? String(this.className),
					keyframes: JSON.stringify(keyframes)
				});
			} catch {
				// Recording never breaks the page.
			}
			return animate.call(this, keyframes, options);
		};
		const start = document.startViewTransition?.bind(document);
		if (start)
			document.startViewTransition = ((callback: ViewTransitionUpdateCallback) => {
				window.rb20Transitions += 1;
				return start(callback);
			}) as typeof document.startViewTransition;
		document.addEventListener('securitypolicyviolation', (e) =>
			window.rb20Csp.push(`${e.violatedDirective} ${e.blockedURI}`)
		);
	});
}

const recorded = (page: Page) => page.evaluate(() => window.rb20Animations);
const moving = (page: Page) =>
	page.evaluate(() =>
		window.rb20Animations.filter((a) => /transform|translate|scale/.test(a.keyframes))
	);
/** CSS animations and transitions now running that move something (not only fade). */
const cssMoving = (page: Page) =>
	page.evaluate(() =>
		document
			.getAnimations()
			.filter((a) => {
				const effect = a.effect as KeyframeEffect | null;
				const frames = JSON.stringify(effect?.getKeyframes() ?? []);
				const property = (a as Animation & { transitionProperty?: string }).transitionProperty;
				return /transform|translate|scale/.test(property ?? frames);
			})
			.map((a) => (a as Animation & { transitionProperty?: string }).transitionProperty ?? a.id)
	);
const expectNoCsp = async (page: Page) =>
	expect(await page.evaluate(() => window.rb20Csp)).toEqual([]);

/** A project with two to-do tasks for this run (created through the UI the first time). */
async function boardWithTwoTasks(page: Page): Promise<string> {
	const key = 'MOTN';
	if ((await page.goto(`/projects/${key}`))?.status() !== 200) {
		await page.goto('/projects/new');
		await page.getByLabel('Key').fill(key);
		await page.getByLabel('Name').fill('Motion check');
		await page.getByRole('button', { name: 'Create project' }).click();
		await expect(page).toHaveURL(`/projects/${key}`);
		for (const title of ['First card', 'Second card']) {
			await page.goto(`/projects/${key}/tasks/new`);
			await page.getByLabel('Title').fill(title);
			await page.getByRole('button', { name: 'Create task' }).click();
			await expect(page).toHaveURL(new RegExp(`/projects/${key}/tasks/\\d+$`));
		}
	}
	return key;
}

test.describe('page transitions (B-AC4, B-AC5)', () => {
	test('a phone navigation cross-fades, and a fast second tap is never lost', async ({ page }) => {
		await instrument(page);
		await page.goto('/');
		await expect(page.locator('button.backdrop')).toHaveCount(0);
		const tabs = page.locator('nav.tabbar');
		await tabs.getByRole('link', { name: 'My tasks' }).click();
		await expect(page).toHaveURL(/\/my-tasks$/);
		// The second tap lands on the next page while its transition may still run.
		const started = Date.now();
		await tabs.getByRole('link', { name: 'Projects' }).click();
		await expect(page).toHaveURL(/\/projects$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
		console.log('motion: second tap to the next page', Date.now() - started, 'ms');
		expect(await page.evaluate(() => window.rb20Transitions)).toBeGreaterThanOrEqual(1);
		await expectNoHorizontalOverflow(page);
		await expectNoCsp(page);
	});

	test('no transition for a query-only change, on a wide screen, or under reduced motion', async ({
		page
	}) => {
		await instrument(page);
		await page.goto('/calendar');
		await page.getByRole('link', { name: 'Next', exact: true }).click();
		await expect(page).toHaveURL(/date=/);
		expect(await page.evaluate(() => window.rb20Transitions)).toBe(0);

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/');
		await page.locator('aside.sidebar').getByRole('link', { name: 'My tasks' }).click();
		await expect(page).toHaveURL(/\/my-tasks$/);
		expect(await page.evaluate(() => window.rb20Transitions)).toBe(0);

		await page.setViewportSize({ width: 402, height: 874 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/');
		await page.locator('nav.tabbar').getByRole('link', { name: 'My tasks' }).click();
		await expect(page).toHaveURL(/\/my-tasks$/);
		expect(await page.evaluate(() => window.rb20Transitions)).toBe(0);
		await expectNoCsp(page);
	});
});

test.describe('sheets and dialogs (B-AC6, B-AC7)', () => {
	test('the More sheet opens without JavaScript (its motion is pure CSS)', async ({
		browser
	}, testInfo) => {
		const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent, storageState } =
			testInfo.project.use;
		const context = await browser.newContext({
			baseURL: `http://localhost:${process.env.RUBY_E2E_PORT ?? 4317}`,
			viewport,
			deviceScaleFactor,
			isMobile,
			hasTouch,
			userAgent,
			storageState,
			javaScriptEnabled: false
		});
		const page = await context.newPage();
		await page.goto('/');
		await page.locator('nav.tabbar summary').click();
		const sheet = page.locator('nav.tabbar .sheet');
		await expect(sheet).toBeVisible();
		await expect(sheet.getByRole('link', { name: 'Account' })).toBeVisible();
		await context.close();
	});

	test('the More sheet slides up with motion and only fades under reduced motion', async ({
		page
	}) => {
		await instrument(page);
		await page.goto('/');
		await page.locator('nav.tabbar summary').click();
		await expect(page.locator('button.backdrop')).toBeVisible();
		// The transition is over in 280 ms, so read the rule rather than catch it running.
		const sheetMotion = () =>
			page.evaluate(
				() => getComputedStyle(document.querySelector('nav.tabbar .sheet')!).transitionProperty
			);
		expect(await sheetMotion()).toContain('transform');
		await page.keyboard.press('Escape');
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.locator('nav.tabbar summary').click();
		await expect(page.locator('button.backdrop')).toBeVisible();
		expect(await sheetMotion()).not.toContain('transform');
		await expectNoCsp(page);
	});

	test('a dialog rises from the bottom on a phone; focus goes in and comes back; reduce only fades', async ({
		page
	}) => {
		await instrument(page);
		await page.addInitScript(() =>
			Object.defineProperty(navigator, 'standalone', { value: false, configurable: true })
		);
		for (const reduce of [false, true]) {
			await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
			await page.goto('/account');
			const opener = page
				.locator('section[aria-labelledby="app-heading"]')
				.getByRole('button', { name: 'Show how' });
			await opener.click();
			const dialog = page.getByRole('dialog', { name: 'Install Ruby' });
			await expect(dialog).toBeVisible();
			const motion = await dialog.evaluate((el) =>
				el
					.getAnimations()
					.map((a) => (a as Animation & { transitionProperty?: string }).transitionProperty)
			);
			if (reduce) expect(motion).not.toContain('transform');
			else expect(motion).toContain('transform');
			expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
			await page.keyboard.press('Escape');
			await expect(dialog).toBeHidden();
			await expect(opener).toBeFocused();
		}
		await expectNoCsp(page);
	});
});

test.describe('board and lists (B-AC8, B-AC9)', () => {
	test('a keyboard move glides the cards (FLIP), keeps focus and highlights the card; nothing moves under reduce', async ({
		page
	}) => {
		await instrument(page);
		const key = await boardWithTwoTasks(page);
		for (const reduce of [false, true]) {
			await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
			await page.goto(`/projects/${key}?view=board`);
			const todo = page.locator('section[data-column="todo"]');
			const first = todo.locator('li.card').first();
			const id = await first.getAttribute('data-card');
			const handle = page.locator(`[data-handle="${id}"]`);
			await page.evaluate(() => (window.rb20Animations = []));
			await handle.focus();
			await page.keyboard.press('Space');
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('Enter');
			await expect(todo.locator('li.card').last()).toHaveAttribute('data-card', id!);
			await expect(handle).toBeFocused();
			const glides = (await moving(page)).filter((a) => a.keyframes.includes('translate('));
			if (reduce) expect(await moving(page)).toEqual([]);
			else expect(glides.length).toBeGreaterThan(0);
			await expectNoHorizontalOverflow(page);
		}
		await expectNoCsp(page);
	});

	test('a page load animates nothing; a posted comment rises in and is highlighted', async ({
		page
	}) => {
		await instrument(page);
		const key = await boardWithTwoTasks(page);
		await page.goto('/notifications');
		await page.waitForLoadState('networkidle');
		expect(await recorded(page)).toEqual([]);
		expect(await cssMoving(page)).toEqual([]);

		await page.goto(`/projects/${key}/tasks/1`);
		// The first comment replaces the empty state (the whole list appears); a later one rises into the list.
		for (const body of ['A fictional first comment.', 'A fictional comment to animate.']) {
			await page.getByLabel('Add a comment', { exact: true }).fill(body);
			await page.getByRole('button', { name: 'Comment', exact: true }).click();
			await page.waitForURL(/#comment-[0-9a-f-]{36}$/);
			await expect(page.getByLabel('Add a comment', { exact: true })).toHaveValue('');
		}
		const commentId = new URL(page.url()).hash.slice(1);
		await expect(page.locator(`#${commentId}`)).toHaveAttribute('data-saved', '');
		// A comment joining a list already on screen rises in (one starting a new list page simply appears).
		expect((await recorded(page)).some((a) => a.target.startsWith('comment-'))).toBe(true);
		// The highlight goes after 1200 ms.
		await expect(page.locator(`#${commentId}`)).not.toHaveAttribute('data-saved', '', {
			timeout: 5_000
		});
		await expectNoCsp(page);
	});
});

test.describe('banners, calendar and reduced motion (B-AC11, B-AC14, B-AC15)', () => {
	test('a clean load runs no banner animation; going offline slides the offline notice in', async ({
		page,
		context
	}) => {
		await instrument(page);
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		expect(await recorded(page)).toEqual([]);
		await context.setOffline(true);
		await expect(page.getByText("You are offline. Changes can't be saved.")).toBeVisible();
		expect((await moving(page)).length).toBeGreaterThan(0);
		await context.setOffline(false);
		await expectNoCsp(page);
	});

	test('the calendar moves once per step, from the side it comes from; never under reduce', async ({
		page
	}) => {
		await instrument(page);
		await page.goto('/calendar');
		await expect(page.locator('.cal-block').first()).toHaveAttribute('data-dir', 'none');
		expect(await recorded(page)).toEqual([]);
		await page.getByRole('link', { name: 'Next', exact: true }).click();
		await expect(page.locator('.cal-block').first()).toHaveAttribute('data-dir', 'next');
		const steps = (await moving(page)).filter((a) => a.keyframes.includes('translateX(8px)'));
		expect(steps.length).toBeGreaterThan(0);
		expect(steps.length).toBeLessThanOrEqual(3);

		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.evaluate(() => (window.rb20Animations = []));
		await page.getByRole('link', { name: 'Previous', exact: true }).click();
		await expect(page.locator('.cal-block').first()).toHaveAttribute('data-dir', 'prev');
		expect(await moving(page)).toEqual([]);
		await expectNoCsp(page);
	});

	test('under reduced motion nothing moves: load, navigation, More sheet, toast-free pages', async ({
		page
	}) => {
		await instrument(page);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/');
		expect(await cssMoving(page)).toEqual([]);
		await page.locator('nav.tabbar').getByRole('link', { name: 'Projects' }).click();
		await expect(page).toHaveURL(/\/projects$/);
		expect(await cssMoving(page)).toEqual([]);
		await page.locator('nav.tabbar summary').click();
		await expect(page.locator('button.backdrop')).toBeVisible();
		expect(await cssMoving(page)).toEqual([]);
		expect(await moving(page)).toEqual([]);
		expect(
			await page.evaluate(
				() => getComputedStyle(document.querySelector('nav.tabbar .sheet')!).transitionProperty
			)
		).not.toContain('transform');
		await expectNoCsp(page);
	});
});
