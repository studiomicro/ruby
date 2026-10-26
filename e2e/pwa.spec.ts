import {
	expect,
	test,
	type Browser,
	type BrowserContext,
	type Page,
	type TestInfo
} from '@playwright/test';
import { emulateSafeAreas, expectNoHorizontalOverflow } from './helpers';
import { pngHeader } from '../scripts/png';
import { SEED_PASSWORD, SEED_USERS } from '../scripts/seed-data';
import { SPLASH_SCREENS } from '../src/lib/shared/splash-screens';

/**
 * RB-20: the installable app against the production build under `wrangler dev` (a secure localhost context): the
 * manifest and the service worker, the read-only offline shell, sign-out on a shared device, the update handshake,
 * install UX, the offline banner and forms, the installed (standalone) layout and landscape safe areas.
 */

const SIGNED_OUT = { cookies: [], origins: [] };
const [ADMIN, MEMBER] = SEED_USERS;
const ORIGIN = `http://localhost:${process.env.RUBY_E2E_PORT ?? 4317}`;
/** A wait for a service worker install, which precaches the shell: an event that does arrive, not a timing claim. */
const SW_INSTALL = { timeout: 30_000 };

const onlyOn = (testInfo: TestInfo, ...projects: string[]) =>
	test.skip(!projects.includes(testInfo.project.name), `runs on ${projects.join(', ')} only`);
const PHONES = ['iphone-402', 'iphone-440', 'phone-360'];

/** CSP violations reported in the page's console. */
function cspViolations(page: Page): string[] {
	const out: string[] = [];
	page.on('console', (msg) => {
		if (/Content Security Policy/i.test(msg.text())) out.push(msg.text());
	});
	return out;
}

/** Waits until the service worker is active and controls this page; returns its script URL. */
async function serviceWorkerReady(page: Page): Promise<string> {
	return page.evaluate(async () => {
		const reg = await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller)
			await new Promise((r) =>
				navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })
			);
		return reg.active?.scriptURL ?? '';
	});
}

/** Every cached request path with its content type and size. */
async function cachedEntries(page: Page) {
	return page.evaluate(async () => {
		const out: { cache: string; path: string; type: string; bytes: number }[] = [];
		for (const name of await caches.keys()) {
			const cache = await caches.open(name);
			for (const request of await cache.keys()) {
				const response = await cache.match(request);
				out.push({
					cache: name,
					path: new URL(request.url).pathname,
					type: response?.headers.get('content-type') ?? '',
					bytes: (await response?.clone().arrayBuffer())?.byteLength ?? 0
				});
			}
		}
		return out;
	});
}

/** Only build files and static files: no page, no page data, no API answer, no download, no HR or people URL. */
function expectOnlyShell(entries: { path: string; type: string }[]) {
	for (const { path, type } of entries) {
		for (const prefix of ['/api/', '/files/', '/hr/', '/people/'])
			expect(path.startsWith(prefix), path).toBe(false);
		expect(path.endsWith('__data.json'), path).toBe(false);
		if (type.startsWith('text/html')) expect(path, `HTML cached at ${path}`).toBe('/offline.html');
	}
}

/** A fresh browser context signed in as `user` through the sign-in form (its own session). */
async function signedIn(
	browser: Browser,
	testInfo: TestInfo,
	user: { email: string },
	extra: Parameters<Browser['newContext']>[0] = {}
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		...deviceOf(testInfo),
		storageState: SIGNED_OUT,
		...extra
	});
	const page = await context.newPage();
	await page.goto('/login');
	await page.getByLabel('E-mail').fill(user.email);
	await page.getByLabel('Password').fill(SEED_PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(`${ORIGIN}/`);
	return { context, page };
}

/** This project's device (viewport, scale, touch, user agent) for a context the test makes itself. */
function deviceOf(testInfo: TestInfo) {
	const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent, locale } =
		testInfo.project.use;
	return { baseURL: ORIGIN, viewport, deviceScaleFactor, isMobile, hasTouch, userAgent, locale };
}

/** The installed-app state: `display-mode: standalone` (CDP) and iOS's `navigator.standalone`. */
async function emulateStandalone(page: Page): Promise<void> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Emulation.setEmulatedMedia', {
		features: [{ name: 'display-mode', value: 'standalone' }]
	});
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
	});
}

const box = async (page: Page, selector: string) => {
	const b = await page.locator(selector).first().boundingBox();
	if (!b) throw new Error(`${selector} has no box`);
	return b;
};
const overlaps = (
	a: { x: number; y: number; width: number; height: number },
	b: { x: number; y: number; width: number; height: number }
) =>
	!(a.y + a.height <= b.y || b.y + b.height <= a.y || a.x + a.width <= b.x || b.x + b.width <= a.x);

test.describe('manifest, icons and static files (signed out)', () => {
	test.use({ storageState: SIGNED_OUT });

	test('the manifest is linked with credentials and served as application/manifest+json; every icon loads (AC1, AC24)', async ({
		page,
		request
	}, testInfo) => {
		onlyOn(testInfo, 'desktop');
		await page.goto('/login');
		const link = page.locator('link[rel="manifest"]');
		await expect(link).toHaveAttribute('href', /\/manifest\.webmanifest$/);
		await expect(link).toHaveAttribute('crossorigin', 'use-credentials');
		const res = await request.get('/manifest.webmanifest');
		expect(res.status()).toBe(200);
		expect(res.headers()['content-type']).toContain('application/manifest+json');
		const manifest = await res.json();
		expect(manifest).toMatchObject({
			name: 'Ruby',
			display: 'standalone',
			start_url: '/',
			scope: '/'
		});
		const images = [
			...manifest.icons,
			...manifest.shortcuts.flatMap((s: { icons: unknown[] }) => s.icons),
			...manifest.screenshots
		] as { src: string; sizes: string; type: string }[];
		for (const image of images) {
			const img = await request.get(image.src);
			expect(img.status(), image.src).toBe(200);
			expect(img.headers()['content-type'], image.src).toBe(image.type);
			if (image.type === 'image/png') {
				const { width, height } = pngHeader(await img.body());
				expect(`${width}x${height}`, image.src).toBe(image.sizes);
			}
		}
		// Static files are reachable signed out (nothing private in them) and carry nosniff.
		for (const path of [
			'/service-worker.js',
			'/offline.html',
			'/offline.css',
			'/icons/apple-touch-icon.png'
		]) {
			const r = await request.get(path, { maxRedirects: 0 });
			expect(r.status(), path).toBe(200);
			expect(r.headers()['x-content-type-options'], path).toBe('nosniff');
		}
		expect((await request.get('/service-worker.js')).headers()['cache-control']).toBe('no-cache');
		expect((await request.get('/_app/version.json')).headers()['cache-control']).toContain(
			'no-store'
		);
		const offline = (await request.get('/offline.html')).headers();
		expect(offline['content-security-policy']).toContain("script-src 'none'");
		expect(offline['x-frame-options']).toBe('DENY');
	});

	test('the head carries the iOS tags and one launch image per iPhone size and scheme (AC3, AC5)', async ({
		page,
		request
	}, testInfo) => {
		onlyOn(testInfo, 'iphone-402');
		await page.goto('/login');
		await expect(
			page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')
		).toHaveAttribute('content', 'default');
		await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
			'href',
			/\/icons\/apple-touch-icon\.png$/
		);
		const links = page.locator('link[rel="apple-touch-startup-image"]');
		await expect(links).toHaveCount(SPLASH_SCREENS.length * 2);
		const iphone17 = SPLASH_SCREENS.find((s) => s.width === 402)!;
		const res = await request.get(iphone17.dark);
		expect(pngHeader(await res.body())).toMatchObject({ width: 1206, height: 2622 });
	});

	test('Chromium finds the app installable; the worker registers from bundled code and caches only the shell (AC6, AC7, AC16, AC25)', async ({
		page
	}, testInfo) => {
		onlyOn(testInfo, 'desktop');
		const csp = cspViolations(page);
		await page.goto('/login');
		expect(await serviceWorkerReady(page)).toBe(`${ORIGIN}/service-worker.js`);
		expect(await page.content()).not.toContain('serviceWorker.register');
		const cdp = await page.context().newCDPSession(page);
		const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
		expect(installabilityErrors).toEqual([]);

		const entries = await cachedEntries(page);
		const paths = entries.map((e) => e.path);
		expect(new Set(entries.map((e) => e.cache)).size).toBe(1);
		expect(entries[0]!.cache).toMatch(/^ruby-shell-\d+$/);
		expect(paths).toEqual(
			expect.arrayContaining([
				'/offline.html',
				'/offline.css',
				'/fonts/geist/1.7.2/Geist-Variable.woff2',
				'/manifest.webmanifest',
				'/icons/icon-192.png'
			])
		);
		expect(paths.some((p) => p.startsWith('/_app/immutable/') && p.endsWith('.js'))).toBe(true);
		expect(paths.some((p) => p.startsWith('/_app/immutable/') && p.endsWith('.css'))).toBe(true);
		expect(paths.filter((p) => /^\/(splash|screenshots)\//.test(p))).toEqual([]);
		expect(paths.filter((p) => p.startsWith('/fonts/') && !p.includes('Geist-Variable'))).toEqual(
			[]
		);
		expectOnlyShell(entries);
		expect(entries.reduce((sum, e) => sum + e.bytes, 0)).toBeLessThanOrEqual(3_000_000);
		expect(csp).toEqual([]);
	});
});

test.describe('offline shell', () => {
	test('offline, a page load shows the offline page; online again, Try again loads the real page (AC9, AC11)', async ({
		page,
		context
	}, testInfo) => {
		onlyOn(testInfo, 'iphone-402', 'desktop');
		const csp = cspViolations(page);
		await page.goto('/my-tasks');
		await expect(page.getByRole('heading', { level: 1, name: 'My tasks' })).toBeVisible();
		await serviceWorkerReady(page);
		expectOnlyShell(await cachedEntries(page));

		await context.setOffline(true);
		const response = await page.goto('/projects');
		expect(response?.status()).toBe(200);
		await expect(page).toHaveTitle('Offline · Ruby');
		await expect(page.getByRole('heading', { level: 1, name: 'You are offline' })).toBeVisible();
		// Its stylesheet came from the cache under its own CSP.
		expect(await page.evaluate(() => getComputedStyle(document.body).margin)).toBe('0px');
		// A reload of a signed-in page shows the offline page too, never the page as it was.
		await page.goto('/my-tasks');
		await page.reload();
		await expect(page).toHaveTitle('Offline · Ruby');
		expect(await page.content()).not.toContain(ADMIN!.email);

		await context.setOffline(false);
		await page.getByRole('link', { name: 'Try again' }).click();
		await expect(page.getByRole('heading', { level: 1, name: /Welcome/ })).toBeVisible();
		expect(csp).toEqual([]);
	});

	test('a 403, a 500 or a cross-origin redirect is never replaced by the offline page (AC10)', async ({
		page,
		context
	}, testInfo) => {
		onlyOn(testInfo, 'desktop');
		await page.goto('/');
		await serviceWorkerReady(page);
		for (const [path, status] of [
			['/projects?rb20=403', 403],
			['/projects?rb20=500', 500]
		] as const) {
			await context.route(`**${path}`, (route) =>
				route.fulfill({ status, contentType: 'text/plain', body: `answer ${status}` })
			);
			const res = await page.goto(path);
			expect(res?.status()).toBe(status);
			await expect(page.locator('body')).toHaveText(`answer ${status}`);
		}
		// Cloudflare Access answers an expired session with a redirect to its own login on another origin.
		await context.route('**/projects?rb20=access', (route) =>
			route.fulfill({
				status: 302,
				headers: { location: 'https://team.example.test/cdn-cgi/access/login' }
			})
		);
		await context.route('https://team.example.test/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Access login</title>' })
		);
		await page.goto('/projects?rb20=access');
		await expect(page).toHaveTitle('Access login');
		expect(page.url()).toContain('team.example.test');
	});
});

test.describe('sign-out on a shared device', () => {
	test.use({ storageState: SIGNED_OUT });

	test('sign-out clears caches and the worker; the next person sees nothing of the last (AC11, AC12)', async ({
		browser
	}, testInfo) => {
		onlyOn(testInfo, 'desktop');
		const { context, page } = await signedIn(browser, testInfo, ADMIN!);
		await serviceWorkerReady(page);
		await page.goto('/account');
		await expect(page.locator('main').getByText(ADMIN!.email)).toBeVisible();
		expectOnlyShell(await cachedEntries(page));

		const signOut = page.waitForResponse(
			(r) => r.url().endsWith('/logout') && r.request().method() === 'POST'
		);
		await page.locator('aside.sidebar').getByRole('button', { name: 'Sign out' }).click();
		const headers = await (await signOut).allHeaders();
		expect(headers['clear-site-data']).toContain('"cache"');
		expect(headers['clear-site-data']).toContain('"storage"');
		await expect(page).toHaveURL(/\/login/);
		// Clear-Site-Data removed the worker and its cache; the sign-in page may already have registered a fresh one,
		// which holds the shell and nothing else (the SIGNED_OUT test below covers the explicit wipe).
		expectOnlyShell(await cachedEntries(page));

		// Offline right after sign-out: no page of the last person is served from anywhere.
		await context.setOffline(true);
		await page.goto('/account').catch(() => {});
		expect(await page.content()).not.toContain(ADMIN!.email);
		await context.setOffline(false);

		// The next person signs in on the same browser.
		await page.goto('/login');
		await page.getByLabel('E-mail').fill(MEMBER!.email);
		await page.getByLabel('Password').fill(SEED_PASSWORD);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(`${ORIGIN}/`);
		await page.goto('/account');
		await expect(page.locator('main').getByText(MEMBER!.email)).toBeVisible();
		expect(await page.content()).not.toContain(ADMIN!.email);
		await context.close();
	});

	test('the SIGNED_OUT message deletes every cache, then downloads the shell again (Safari ignores Clear-Site-Data)', async ({
		page,
		context
	}, testInfo) => {
		onlyOn(testInfo, 'desktop');
		await page.goto('/login');
		await serviceWorkerReady(page);
		const before = await cachedEntries(page);
		expect(before.length).toBeGreaterThan(0);
		// Something a previous session left behind, in its own cache and in the shell cache.
		await page.evaluate(async (shell) => {
			await (await caches.open('left-behind')).put('/marker', new Response('A'));
			await (await caches.open(shell)).put('/marker', new Response('A'));
		}, before[0]!.cache);
		await page.evaluate(() =>
			navigator.serviceWorker.controller?.postMessage({ type: 'SIGNED_OUT' })
		);
		await expect
			.poll(async () => (await cachedEntries(page)).some((e) => e.path === '/marker'))
			.toBe(false);
		await expect.poll(() => page.evaluate(() => caches.keys())).toEqual([before[0]!.cache]);
		// The shell is back, so the offline page still works for the next person.
		await expect.poll(async () => (await cachedEntries(page)).length).toBe(before.length);
		expectOnlyShell(await cachedEntries(page));
		await context.setOffline(true);
		await page.goto('/projects');
		await expect(page).toHaveTitle('Offline · Ruby');
		await context.setOffline(false);
	});
});

test.describe('update flow (AC13)', () => {
	test.use({ storageState: SIGNED_OUT });

	test('a waiting worker shows the banner; Reload asks first with unsaved input, then hands over and reloads once', async ({
		browser
	}, testInfo) => {
		onlyOn(testInfo, 'iphone-402');
		test.setTimeout(120_000);
		const { context, page } = await signedIn(browser, testInfo, ADMIN!);
		await context.addInitScript(() => {
			sessionStorage.setItem(
				'rb20-loads',
				String(Number(sessionStorage.getItem('rb20-loads') ?? '0') + 1)
			);
		});
		await page.goto('/account');
		await serviceWorkerReady(page);
		const loads = () => page.evaluate(() => Number(sessionStorage.getItem('rb20-loads') ?? '0'));
		const workers = () =>
			page.evaluate(async () => {
				const reg = await navigator.serviceWorker.getRegistration();
				const name = (w: ServiceWorker | null | undefined) =>
					w ? new URL(w.scriptURL).pathname.slice(1) + new URL(w.scriptURL).search : null;
				return { active: name(reg?.active), waiting: name(reg?.waiting) };
			});
		const banner = page.locator('.update');
		await expect(banner).toHaveCount(0);

		// Playwright cannot rewrite the worker script the browser fetches, so the "next build" is the same bundle
		// under another script URL, which the browser installs as a new version just the same: it waits.
		await page.evaluate(() =>
			navigator.serviceWorker.register('/service-worker.js?build=next', {
				type: 'module',
				scope: '/'
			})
		);
		await expect(banner).toBeVisible(SW_INSTALL);
		expect(await workers()).toEqual({
			active: 'service-worker.js',
			waiting: 'service-worker.js?build=next'
		});

		// Unsaved input: the confirm dialog comes first and nothing reloads.
		const before = await loads();
		await page.getByLabel('Name').fill('Unsaved name');
		await banner.getByRole('button', { name: 'Reload' }).click();
		const confirm = page.getByRole('dialog', { name: 'Reload and lose your changes?' });
		await expect(confirm).toBeVisible();
		await confirm.getByRole('button', { name: 'Keep editing' }).click();
		expect(await loads()).toBe(before);
		expect((await workers()).waiting).toBe('service-worker.js?build=next');

		await banner.getByRole('button', { name: 'Reload' }).click();
		await confirm.getByRole('button', { name: 'Reload anyway' }).click();
		await expect.poll(() => loads().catch(() => before), { timeout: 20_000 }).toBe(before + 1);
		// The new worker took over. (The reloaded page registers /service-worker.js again, which the browser now sees
		// as the next update: it installs and waits for the next Reload, as any later build would.)
		await expect.poll(async () => (await workers()).active).toBe('service-worker.js?build=next');
		// One shell cache only: the activate step deleted every other one.
		expect(await page.evaluate(() => caches.keys())).toHaveLength(1);
		await page.waitForTimeout(1000);
		expect(await loads()).toBe(before + 1);
		await context.close();
	});
});

test.describe('install UX (AC17)', () => {
	test('a captured beforeinstallprompt shows the row in Account and More; one prompt per tap; dismissed hides it for 30 days', async ({
		page
	}, testInfo) => {
		onlyOn(testInfo, 'iphone-402', 'desktop');
		await page.addInitScript(() => {
			const w = window as unknown as { rb20Prompts: number };
			w.rb20Prompts = 0;
			window.addEventListener('rb20-offer', () => {
				const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
					prompt: () => Promise<void>;
					userChoice: Promise<{ outcome: string }>;
				};
				event.prompt = async () => void (w.rb20Prompts += 1);
				event.userChoice = Promise.resolve({ outcome: 'dismissed' });
				window.dispatchEvent(event);
			});
		});
		await page.goto('/account');
		const app = page.locator('section[aria-labelledby="app-heading"]');
		// The row is server-rendered; once hydrated it knows this browser offers no install path yet (no button).
		await expect(app.getByText('Install Ruby', { exact: true })).toBeVisible();
		await expect(app.getByText('This browser offers no install button here.')).toBeVisible();
		await page.evaluate(() => window.dispatchEvent(new Event('rb20-offer')));
		const install = app.getByRole('button', { name: 'Install' });
		await expect(install).toBeVisible();
		expect(
			await page.evaluate(() => (window as unknown as { rb20Prompts: number }).rb20Prompts)
		).toBe(0);
		if (testInfo.project.name === 'iphone-402') {
			await page.locator('nav.tabbar summary').click();
			// The sheet closes on Escape once the shell has hydrated (its backdrop shows then).
			await expect(page.locator('button.backdrop')).toBeVisible();
			await expect(
				page.locator('nav.tabbar .sheet').getByRole('button', { name: 'Install Ruby' })
			).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(page.locator('nav.tabbar .sheet')).toBeHidden();
		}
		await install.click();
		await expect(install).toHaveCount(0);
		expect(
			await page.evaluate(() => (window as unknown as { rb20Prompts: number }).rb20Prompts)
		).toBe(1);
		expect(await page.evaluate(() => localStorage.getItem('ruby.install.dismissed'))).toMatch(
			/^\d+$/
		);
		await expect(app.getByText('You chose not to install Ruby for now.')).toBeVisible();
		// No dialog, banner or toast on load at any time.
		await page.reload();
		await page.evaluate(() => window.dispatchEvent(new Event('rb20-offer')));
		await expect(app.getByText('You chose not to install Ruby for now.')).toBeVisible();
		await expect(page.getByRole('dialog')).toHaveCount(0);
	});

	test('iOS Safari: the row opens the three steps; an in-app browser is told to open Safari', async ({
		browser
	}, testInfo) => {
		onlyOn(testInfo, 'iphone-402');
		const ios = async (userAgent?: string) => {
			const context = await browser.newContext({
				...deviceOf(testInfo),
				...(userAgent ? { userAgent } : {})
			});
			await context.addInitScript(() =>
				Object.defineProperty(navigator, 'standalone', { value: false, configurable: true })
			);
			const page = await context.newPage();
			await page.goto('/account');
			return { context, page };
		};
		const safari = await ios();
		const app = safari.page.locator('section[aria-labelledby="app-heading"]');
		await expect(safari.page.getByRole('dialog')).toHaveCount(0);
		await app.getByRole('button', { name: 'Show how' }).click();
		const dialog = safari.page.getByRole('dialog', { name: 'Install Ruby' });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText('Scroll and tap "Add to Home Screen".')).toBeVisible();
		await expect(dialog.getByText('Open this page in Safari')).toHaveCount(0);
		await expectNoHorizontalOverflow(safari.page);
		await safari.context.close();

		const inApp = await ios(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0'
		);
		await expect(
			inApp.page
				.locator('section[aria-labelledby="app-heading"]')
				.getByText('Open this page in Safari to install Ruby.')
		).toBeVisible();
		await inApp.context.close();
	});

	test('standalone: "Ruby is installed", no install button anywhere', async ({
		page
	}, testInfo) => {
		onlyOn(testInfo, 'iphone-402');
		await emulateStandalone(page);
		await page.goto('/account');
		await expect(page.getByText('Ruby is installed on this device.')).toBeVisible();
		await page.locator('nav.tabbar summary').click();
		await expect(
			page.locator('nav.tabbar .sheet').getByRole('button', { name: 'Install Ruby' })
		).toHaveCount(0);
	});
});

test.describe('offline banner and forms', () => {
	test('the offline banner shows within a second, clears the tab bar, and hides again (AC18)', async ({
		page,
		context,
		viewport
	}, testInfo) => {
		onlyOn(testInfo, ...PHONES);
		await page.goto('/');
		await serviceWorkerReady(page);
		await emulateSafeAreas(page, { top: 59, bottom: 34 });
		const banner = page.getByText("You are offline. Changes can't be saved.");
		await context.setOffline(true);
		await expect(banner).toBeVisible({ timeout: 1_000 });
		const b = (await banner.boundingBox())!;
		const bar = await box(page, 'nav.tabbar');
		expect(b.y + b.height).toBeLessThanOrEqual(bar.y);
		expect(b.y + b.height).toBeLessThanOrEqual(viewport!.height - 34);
		await expectNoHorizontalOverflow(page);
		await context.setOffline(false);
		await expect(banner).toHaveCount(0);
	});

	test('a form sent offline keeps its input, says so, sends nothing; back online one submit saves once (AC19)', async ({
		page,
		context
	}, testInfo) => {
		onlyOn(testInfo, 'iphone-402', 'desktop');
		await page.goto('/account');
		await serviceWorkerReady(page);
		const posts: string[] = [];
		page.on('request', (r) => {
			if (r.method() === 'POST') posts.push(r.url());
		});
		const form = page.locator('form[action="?/name"]');
		const name = form.getByLabel('Name');
		const current = await name.inputValue();
		await context.setOffline(true);
		await name.fill(`${current} `);
		await name.fill(current);
		await form.getByRole('button', { name: 'Save name' }).click();
		await expect(form.getByRole('alert')).toHaveText(
			'You are offline. Nothing was saved. Try again when you are back online.'
		);
		await expect(form.getByRole('button', { name: 'Save name' })).toBeEnabled();
		expect(await name.inputValue()).toBe(current);
		expect(posts).toEqual([]);
		expect(
			await page.evaluate(async () => ({
				local: localStorage.length,
				dbs: (await indexedDB.databases()).length
			}))
		).toEqual({ local: 0, dbs: 0 });
		expectOnlyShell(await cachedEntries(page));

		await context.setOffline(false);
		await expect(page.getByText("You are offline. Changes can't be saved.")).toHaveCount(0);
		await form.getByRole('button', { name: 'Save name' }).click();
		await expect(form.getByText('Name saved.')).toBeVisible();
		await expect(form.getByRole('alert')).toHaveCount(0);
		expect(posts.filter((u) => u.includes('?/name'))).toHaveLength(1);
	});

	test('a request that fails mid-way keeps the input and says the change may have been saved, not an error page', async ({
		page,
		context
	}, testInfo) => {
		onlyOn(testInfo, 'desktop');
		await page.goto('/account');
		await serviceWorkerReady(page);
		await context.route('**/account?/name', (route) => route.abort('internetdisconnected'));
		const form = page.locator('form[action="?/name"]');
		await form.getByLabel('Name').fill('Still typed here');
		await form.getByRole('button', { name: 'Save name' }).click();
		await expect(form.getByRole('alert')).toHaveText(
			'The connection dropped. Your change may have been saved. Reload the page to check before trying again.'
		);
		await expect(form.getByLabel('Name')).toHaveValue('Still typed here');
		await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
		await expect(form.getByRole('button', { name: 'Save name' })).toBeEnabled();
	});
});

test.describe('installed app layout', () => {
	test('standalone: no rubber-band on the root, contained sheet and dialogs, no sideways scroll, 16 px inputs (AC20)', async ({
		page
	}, testInfo) => {
		onlyOn(testInfo, ...PHONES);
		await emulateStandalone(page);
		await page.goto('/account');
		// The root layout marks the installed app once it has hydrated.
		await expect(page.locator('html[data-display="standalone"]')).toHaveCount(1);
		await emulateSafeAreas(page, { top: 59, bottom: 34 });
		const styles = await page.evaluate(() => ({
			html: getComputedStyle(document.documentElement).overscrollBehaviorY,
			body: getComputedStyle(document.body).overscrollBehaviorY,
			sheet: getComputedStyle(document.querySelector('nav.tabbar .sheet')!).overscrollBehaviorY,
			dialog: getComputedStyle(document.querySelector('dialog')!).overscrollBehaviorY,
			inputs: [
				...document.querySelectorAll('main input:not([type=checkbox]), main select, main textarea')
			].map((el) => parseFloat(getComputedStyle(el).fontSize))
		}));
		expect(styles).toMatchObject({
			html: 'none',
			body: 'none',
			sheet: 'contain',
			dialog: 'contain'
		});
		for (const size of styles.inputs) expect(size).toBeGreaterThanOrEqual(16);
		const brand = await box(page, 'header.topbar .brand');
		expect(brand.y).toBeGreaterThanOrEqual(59);
		const tab = await box(page, 'nav.tabbar .tab');
		expect(tab.y + tab.height).toBeLessThanOrEqual(page.viewportSize()!.height - 34 + 0.5);
		await expectNoHorizontalOverflow(page);
	});

	test('the back control: standalone only, never on a tab; back through history, else to the parent (AC22)', async ({
		page
	}, testInfo) => {
		onlyOn(testInfo, 'iphone-402');
		// A browser tab has its own back button: no control.
		await page.goto('/people');
		await expect(page.locator('header.topbar .back-link')).toBeHidden();

		await emulateStandalone(page);
		await page.goto('/');
		const back = page.locator('header.topbar .back-link');
		await expect(back).toHaveCount(0);
		for (const tab of ['/my-tasks', '/projects', '/kb']) {
			await page.goto(tab);
			await expect(back).toHaveCount(0);
		}
		// Opened directly (no in-app page behind it): the parent route.
		await page.goto('/people/org');
		await expect(back).toBeVisible();
		expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		await back.click();
		await expect(page).toHaveURL(`${ORIGIN}/people`);
		// Reached in-app: back through history to where it came from.
		await page.goto('/');
		await page.locator('nav.tabbar summary').click();
		await page.locator('nav.tabbar .sheet').getByRole('link', { name: 'People' }).click();
		await expect(page).toHaveURL(`${ORIGIN}/people`);
		await back.click();
		await expect(page).toHaveURL(`${ORIGIN}/`);
	});

	test('Refresh in More reloads the data, says so and keeps typed input (AC23)', async ({
		page
	}, testInfo) => {
		onlyOn(testInfo, 'iphone-402');
		await page.goto('/account');
		const name = page.locator('form[action="?/name"]').getByLabel('Name');
		await name.fill('Typed, not saved');
		const data = page.waitForRequest((r) => r.url().includes('__data.json'));
		await page.locator('nav.tabbar summary').click();
		const sheet = page.locator('nav.tabbar .sheet');
		await expect(page.locator('button.backdrop')).toBeVisible();
		await sheet.getByRole('button', { name: 'Refresh' }).click();
		await data;
		await expect(sheet.getByText('Updated just now.')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(name).toHaveValue('Typed, not saved');
	});
});

test.describe('landscape safe areas (AC21)', () => {
	for (const [width, height] of [
		[874, 402],
		[956, 440],
		[640, 360]
	] as const)
		test(`${width}x${height} with 59 px side insets: nothing fixed is clipped, no sideways scroll`, async ({
			page,
			context
		}, testInfo) => {
			onlyOn(testInfo, 'iphone-402');
			await page.setViewportSize({ width, height });
			await page.goto('/account');
			await serviceWorkerReady(page);
			await emulateSafeAreas(page, { left: 59, right: 59, bottom: 21 });
			await context.setOffline(true);
			await expect(page.getByText("You are offline. Changes can't be saved.")).toBeVisible();
			const heading = await box(page, 'main h1');
			expect(heading.x).toBeGreaterThanOrEqual(59);
			const banner = (await page
				.getByText("You are offline. Changes can't be saved.")
				.boundingBox())!;
			expect(banner.x).toBeGreaterThanOrEqual(59);
			expect(banner.x + banner.width).toBeLessThanOrEqual(width - 59 + 0.5);
			if (width < 768) {
				const brand = await box(page, 'header.topbar .brand');
				expect(brand.x).toBeGreaterThanOrEqual(59);
				const first = await box(page, 'nav.tabbar .tab');
				expect(first.x).toBeGreaterThanOrEqual(59);
				const tabs = await page.locator('nav.tabbar .tab').all();
				const last = (await tabs.at(-1)!.boundingBox())!;
				expect(last.x + last.width).toBeLessThanOrEqual(width - 59 + 0.5);
				const bar = await box(page, 'nav.tabbar');
				expect(overlaps(banner, bar)).toBe(false);
			} else {
				const brand = await box(page, 'aside.sidebar .brand');
				expect(brand.x).toBeGreaterThanOrEqual(59);
				const main = await box(page, 'main');
				const field = await box(page, 'main input');
				expect(field.x + field.width).toBeLessThanOrEqual(main.x + main.width);
				expect(field.x + field.width).toBeLessThanOrEqual(width - 59 + 0.5);
			}
			await expectNoHorizontalOverflow(page);
			await context.setOffline(false);
		});
});
