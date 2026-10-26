import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { decodePng, pngHeader } from '../scripts/png';
import { SEED_PASSWORD, SEED_USERS } from '../scripts/seed-data';
import { SPLASH_SCREENS } from '../src/lib/shared/splash-screens';
import { expectNoHorizontalOverflow } from './helpers';

/** RB-20 QA: independent proofs, written by QA. Static-file checks run once; browser checks run per project. */

const SIGNED_OUT = { cookies: [], origins: [] };
const [ADMIN] = SEED_USERS;
const ORIGIN = `http://localhost:${process.env.RUBY_E2E_PORT ?? 4317}`;
const onlyOn = (testInfo: TestInfo, ...projects: string[]) =>
	test.skip(!projects.includes(testInfo.project.name), `runs on ${projects.join(', ')} only`);

async function swReady(page: Page) {
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller)
			await new Promise((r) =>
				navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })
			);
	});
}

async function cachedPaths(page: Page) {
	return page.evaluate(async () => {
		const out: { cache: string; path: string; type: string }[] = [];
		for (const name of await caches.keys()) {
			const cache = await caches.open(name);
			for (const req of await cache.keys()) {
				const res = await cache.match(req);
				out.push({
					cache: name,
					path: new URL(req.url).pathname + new URL(req.url).search,
					type: res?.headers.get('content-type') ?? ''
				});
			}
		}
		return out;
	});
}

test.describe('static assets (signed out)', () => {
	test.use({ storageState: SIGNED_OUT });

	test('manifest: fields, icon pixel sizes, maskable safe zone, shortcuts, screenshots', async ({
		request
	}, testInfo) => {
		onlyOn(testInfo, 'desktop');
		const res = await request.get('/manifest.webmanifest');
		expect(res.status()).toBe(200);
		expect(res.headers()['content-type']).toContain('application/manifest+json');
		const m = await res.json();
		expect(m).toMatchObject({
			name: 'Ruby',
			start_url: '/',
			scope: '/',
			id: '/',
			display: 'standalone'
		});
		expect(m.short_name).toBeTruthy();
		const purposes = m.icons.map(
			(i: { sizes: string; purpose: string }) => `${i.sizes}/${i.purpose}`
		);
		for (const want of [
			'192x192/any',
			'512x512/any',
			'192x192/maskable',
			'512x512/maskable',
			'512x512/monochrome'
		])
			expect(purposes).toContain(want);
		for (const icon of m.icons as { src: string; sizes: string; type: string }[]) {
			const r = await request.get(icon.src);
			expect(r.status(), icon.src).toBe(200);
			if (icon.type === 'image/png') {
				const h = pngHeader(await r.body());
				expect(`${h.width}x${h.height}`, icon.src).toBe(icon.sizes);
			}
		}
		// Maskable: the four corners are plain background; the centre is not (mark inside the 80 % circle).
		for (const size of [192, 512]) {
			const img = decodePng(readFileSync(`static/icons/icon-maskable-${size}.png`));
			const px = (x: number, y: number) => {
				const i = (y * img.width + x) * 4;
				return [...img.data.subarray(i, i + 4)].join(',');
			};
			const corner = px(0, 0);
			expect(px(img.width - 1, 0)).toBe(corner);
			expect(px(0, img.height - 1)).toBe(corner);
			expect(px(img.width - 1, img.height - 1)).toBe(corner);
			// No pixel outside the 80 % circle differs from the corner colour.
			const r = (img.width / 2) * 0.8;
			let outside = 0;
			for (let y = 0; y < img.height; y += 2)
				for (let x = 0; x < img.width; x += 2)
					if (Math.hypot(x - img.width / 2, y - img.height / 2) > r + 1 && px(x, y) !== corner)
						outside++;
			expect(outside, `maskable-${size} mark outside safe circle`).toBe(0);
		}
		// Shortcuts resolve (signed out: a redirect to login is still a route; 404 is not) and sit in scope.
		expect(m.shortcuts.length).toBeLessThanOrEqual(4);
		for (const s of m.shortcuts as { url: string; icons: { src: string }[] }[]) {
			expect(s.url.startsWith('/')).toBe(true);
			const r = await request.get(s.url, { maxRedirects: 0 });
			expect(r.status(), s.url).not.toBe(404);
			expect((await request.get(s.icons[0]!.src)).status()).toBe(200);
		}
		for (const s of m.screenshots as { src: string; sizes: string }[]) {
			const h = pngHeader(await (await request.get(s.src)).body());
			expect(`${h.width}x${h.height}`, s.src).toBe(s.sizes);
		}
	});

	test('apple-touch-icon is 180x180 without alpha; launch images for 402x874 and 440x956 match their media', async ({
		request,
		page
	}, testInfo) => {
		onlyOn(testInfo, 'desktop');
		const icon = pngHeader(await (await request.get('/icons/apple-touch-icon.png')).body());
		expect(icon).toMatchObject({ width: 180, height: 180 });
		expect([0, 2]).toContain(icon.colorType); // greyscale or RGB, no alpha
		await page.goto('/login');
		const links = await page
			.locator('link[rel="apple-touch-startup-image"]')
			.evaluateAll((els) =>
				els.map((e) => ({ href: e.getAttribute('href')!, media: e.getAttribute('media')! }))
			);
		for (const [w, h, pw, ph] of [
			[402, 874, 1206, 2622],
			[440, 956, 1320, 2868]
		] as const) {
			for (const scheme of ['light', 'dark']) {
				const link = links.find(
					(l) =>
						l.media.includes(`device-width: ${w}px`) &&
						l.media.includes(`device-height: ${h}px`) &&
						l.media.includes(`prefers-color-scheme: ${scheme}`)
				);
				expect(link, `${w}x${h} ${scheme}`).toBeTruthy();
				expect(link!.media).toContain('-webkit-device-pixel-ratio: 3');
				expect(link!.media).toContain('orientation: portrait');
				const hd = pngHeader(await (await request.get(link!.href)).body());
				expect(hd).toMatchObject({ width: pw, height: ph });
			}
		}
		// 360 wide is an Android size: iOS has no 360pt phone, so no launch image is expected (documented, not a defect).
		expect(SPLASH_SCREENS.some((s) => s.width === 360)).toBe(false);
		expect(SPLASH_SCREENS.some((s) => s.width === 420 && s.height === 912)).toBe(true); // iPhone Air
	});

	test('offline.html, service-worker.js and the manifest are served with their headers', async ({
		request
	}, testInfo) => {
		onlyOn(testInfo, 'desktop');
		const off = await request.get('/offline.html');
		expect(off.status()).toBe(200);
		expect(await off.text()).not.toMatch(/<script/i);
		const sw = await request.get('/service-worker.js');
		expect(sw.status()).toBe(200);
		expect(sw.headers()['content-type']).toMatch(/javascript/);
		const ver = await request.get('/_app/version.json');
		expect(ver.headers()['cache-control']).toContain('no-store');
	});
});

test.describe('shared-device privacy', () => {
	test.use({ storageState: SIGNED_OUT });

	test('after many authenticated pages Cache Storage holds no page, data or user-specific URL; sign-out wipes it', async ({
		browser
	}, testInfo) => {
		onlyOn(testInfo, 'desktop');
		const context = await browser.newContext({ baseURL: ORIGIN, storageState: SIGNED_OUT });
		const page = await context.newPage();
		await page.goto('/login');
		await page.getByLabel('E-mail').fill(ADMIN!.email);
		await page.getByLabel('Password').fill(SEED_PASSWORD);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(`${ORIGIN}/`);
		await swReady(page);
		const routes = [
			'/my-tasks',
			'/projects',
			'/people',
			'/kb',
			'/calendar',
			'/search?q=a',
			'/notifications',
			'/reminders',
			'/time-off',
			'/account',
			'/releases',
			'/admin/users',
			'/hr'
		];
		for (const r of routes) await page.goto(r);
		// Follow one project, one person, one task for the dynamic routes.
		await page.goto('/projects');
		const proj = page.locator('main a[href^="/projects/"]').first();
		if (await proj.count()) await proj.click();
		await page.goto('/people');
		const person = page.locator('main a[href^="/people/"]').first();
		if (await person.count()) await person.click();
		const entries = await cachedPaths(page);
		console.log('QA caches:', JSON.stringify(entries.map((e) => e.path)));
		expect(entries.length).toBeGreaterThan(0);
		for (const e of entries) {
			expect(e.path, e.path).not.toMatch(
				/^\/(api|files|hr|people|projects|kb|admin|account|my-tasks|search)/
			);
			expect(e.path.includes('__data.json')).toBe(false);
			expect(e.path.includes('q=')).toBe(false);
			if (e.type.startsWith('text/html')) expect(e.path).toBe('/offline.html');
		}
		// Bodies: no cached text mentions the user's email.
		const leaks = await page.evaluate(async (email) => {
			const hit: string[] = [];
			for (const n of await caches.keys()) {
				const c = await caches.open(n);
				for (const req of await c.keys()) {
					const res = await c.match(req);
					const type = res?.headers.get('content-type') ?? '';
					if (/text|json|javascript|css/.test(type) && (await res!.clone().text()).includes(email))
						hit.push(req.url);
				}
			}
			return hit;
		}, ADMIN!.email);
		expect(leaks).toEqual([]);

		// Sign out through the form, then wipe check (Clear-Site-Data + SIGNED_OUT).
		await page.goto('/account');
		const wait = page.waitForResponse(
			(r) => r.url().endsWith('/logout') && r.request().method() === 'POST'
		);
		const btn = page.getByRole('button', { name: 'Sign out' });
		await btn.first().click();
		const csd = (await (await wait).allHeaders())['clear-site-data'] ?? '';
		expect(csd).toContain('"cache"');
		expect(csd).toContain('"storage"');
		await expect(page).toHaveURL(/\/login/);
		// Clear-Site-Data removed the old worker; /login registers a fresh one holding only the shell. Wipe it by message.
		const afterLogout = await cachedPaths(page);
		for (const e of afterLogout)
			if (e.type.startsWith('text/html')) expect(e.path).toBe('/offline.html');
		await swReady(page);
		await page.evaluate(() =>
			navigator.serviceWorker.controller?.postMessage({ type: 'SIGNED_OUT' })
		);
		// The message empties every cache and then downloads the static shell again (the red team's I1 fix), so what is
		// left is the shell only: no page, nothing of the signed-out person.
		await expect
			.poll(async () =>
				(await cachedPaths(page)).filter(
					(e) => e.type.startsWith('text/html') && e.path !== '/offline.html'
				)
			)
			.toEqual([]);
		expect(await page.evaluate(() => caches.keys())).toHaveLength(1);
		await context.close();
	});
});

test.describe('layout and install guidance', () => {
	test('PWA pages never scroll sideways, and nothing nags to install on load', async ({
		page
	}, testInfo) => {
		onlyOn(testInfo, 'iphone-402', 'iphone-440', 'phone-360');
		await page.addInitScript(() => {
			window.addEventListener('DOMContentLoaded', () => {
				// A synthetic install offer, as Chromium would send it.
				const ev = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
					prompt?: () => Promise<void>;
					userChoice?: Promise<{ outcome: string }>;
				};
				ev.prompt = async () => {
					(window as unknown as { __prompts: number }).__prompts =
						((window as unknown as { __prompts?: number }).__prompts ?? 0) + 1;
				};
				ev.userChoice = new Promise(() => {});
				window.dispatchEvent(ev);
			});
		});
		for (const route of ['/', '/account', '/projects', '/my-tasks', '/people', '/releases']) {
			await page.goto(route);
			await expectNoHorizontalOverflow(page);
			// No modal, no toast, no banner about installing on load.
			await expect(page.locator('dialog[open]')).toHaveCount(0);
			await expect(
				page.locator('[role="status"], [role="alert"]').filter({ hasText: /install/i })
			).toHaveCount(0);
			const prompts = await page.evaluate(
				() => (window as unknown as { __prompts?: number }).__prompts ?? 0
			);
			expect(prompts, `prompt() called on load of ${route}`).toBe(0);
		}
		await page.goto('/offline.html');
		await expectNoHorizontalOverflow(page);
		await expect(page.getByRole('heading', { level: 1, name: 'You are offline' })).toBeVisible();
	});

	test('offline with the worker in control: the offline page fits the screen and Try again is a real link', async ({
		page,
		context
	}) => {
		await page.goto('/my-tasks');
		await swReady(page);
		await context.setOffline(true);
		const res = await page.goto('/projects');
		expect(res?.status()).toBe(200);
		await expect(page).toHaveTitle(/Offline/);
		await expectNoHorizontalOverflow(page);
		await expect(page.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', /.+/);
		await context.setOffline(false);
	});
});
