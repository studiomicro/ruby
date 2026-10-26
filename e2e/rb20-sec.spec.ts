import {
	expect,
	test,
	type Browser,
	type BrowserContext,
	type Page,
	type TestInfo
} from '@playwright/test';
import { SEED_PASSWORD, SEED_USERS } from '../scripts/seed-data';

/**
 * RB-20 red-team proofs against the production build under `wrangler dev`: what can land in Cache Storage, what the
 * precache accepts, which static paths answer, the update/sign-out handshake, two people on one browser, and the
 * offline form guard. Desktop Chromium only. See docs/features/rb-20-mobile-pwa/SECURITY_REPORT.md.
 */

const SIGNED_OUT = { cookies: [], origins: [] };
const [ADMIN, MEMBER] = SEED_USERS;
const ORIGIN = `http://localhost:${process.env.RUBY_E2E_PORT ?? 4317}`;

const desktopOnly = (testInfo: TestInfo) =>
	test.skip(testInfo.project.name !== 'desktop', 'desktop only');

async function serviceWorkerReady(page: Page): Promise<void> {
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller)
			await new Promise((r) =>
				navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })
			);
	});
}

async function cacheDump(page: Page) {
	return page.evaluate(async () => {
		const out: { cache: string; url: string; type: string; body: string }[] = [];
		for (const name of await caches.keys()) {
			const cache = await caches.open(name);
			for (const request of await cache.keys()) {
				const response = await cache.match(request);
				const type = response?.headers.get('content-type') ?? '';
				const body = /text|json|javascript|html|css/.test(type)
					? ((await response?.clone().text()) ?? '')
					: '';
				out.push({ cache: name, url: request.url, type, body });
			}
		}
		return out;
	});
}

async function signedIn(
	browser: Browser,
	user: { email: string },
	context?: BrowserContext
): Promise<{ context: BrowserContext; page: Page }> {
	context ??= await browser.newContext({ baseURL: ORIGIN, storageState: SIGNED_OUT });
	const page = await context.newPage();
	await page.goto('/login');
	await page.getByLabel('E-mail').fill(user.email);
	await page.getByLabel('Password').fill(SEED_PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(`${ORIGIN}/`);
	return { context, page };
}

test.describe('cache contents', () => {
	test('browsing every data route and every bypass variant adds nothing to Cache Storage', async ({
		page
	}, testInfo) => {
		desktopOnly(testInfo);
		await page.goto('/');
		await serviceWorkerReady(page);
		const before = await cacheDump(page);
		expect(before.length).toBeGreaterThan(0);

		for (const path of [
			'/people',
			'/people/org',
			'/hr/audit',
			'/calendar',
			'/notifications',
			'/my-tasks',
			'/kb',
			'/search?q=a',
			'/account',
			'/admin/users',
			'/time-off'
		])
			await page.goto(path);

		// Requests a page or an attacker on the page could make, through the worker.
		const statuses = await page.evaluate(async () => {
			const out: Record<string, number | string> = {};
			const tries: [string, RequestInit][] = [
				['/__data.json?x-sveltekit-invalidated=1', {}],
				['/people/__data.json', {}],
				['/api/mentions?q=a', {}],
				['/files', {}],
				['/files/does-not-exist', {}],
				['/hr/export', {}],
				['/HR/export', {}],
				['//files/does-not-exist', {}],
				['/files%2Fdoes-not-exist', {}],
				['/./people/x', {}],
				['/_app/immutable/%2e%2e/%2e%2e/people', {}],
				['/manifest.webmanifest?u=1', {}],
				['/offline.css', { method: 'HEAD' }],
				['/offline.css', { headers: { range: 'bytes=0-3' } }],
				['/people', { headers: { range: 'bytes=0-3' } }],
				['/_app/version.json', {}]
			];
			for (const [url, init] of tries) {
				try {
					out[`${init.method ?? 'GET'} ${url} ${init.headers ? 'range' : ''}`] = (
						await fetch(url, { ...init, redirect: 'manual' })
					).status;
				} catch (e) {
					out[url] = String(e);
				}
			}
			return out;
		});
		expect(Object.keys(statuses).length).toBe(16);

		const after = await cacheDump(page);
		expect(after.map((e) => e.url).sort()).toEqual(before.map((e) => e.url).sort());
		for (const entry of after) {
			const path = new URL(entry.url).pathname;
			expect(new URL(entry.url).origin).toBe(ORIGIN);
			expect(new URL(entry.url).search).toBe('');
			expect(path).not.toMatch(/^\/(api|files|hr|people)(\/|$)|__data\.json$|version\.json$/i);
			if (entry.type.includes('html')) expect(path).toBe('/offline.html');
			// No person's data in any cached text body.
			for (const user of SEED_USERS) expect(entry.body, path).not.toContain(user.email);
		}
	});

	test('fixed (L1): a same-origin redirect during install fails the install; nothing is stored under a shell path', async ({
		browser
	}, testInfo) => {
		desktopOnly(testInfo);
		const context = await browser.newContext({ baseURL: ORIGIN, storageState: SIGNED_OUT });
		// During install, a same-origin redirect answers one shell file (an Access re-auth hop, a proxy, a misconfigured
		// html_handling). Before the fix, the sign-in page's HTML was stored as /offline.css.
		await context.route('**/offline.css', (route) =>
			route.fulfill({ status: 302, headers: { location: '/login?rb20sec=1' } })
		);
		const page = await context.newPage();
		await page.goto('/login');
		const state = await page.evaluate(async () => {
			const reg = await navigator.serviceWorker.getRegistration();
			const worker = reg?.installing ?? reg?.waiting ?? reg?.active;
			if (worker && worker.state !== 'redundant' && worker.state !== 'activated')
				await new Promise<void>((r) => {
					const check = () => {
						if (worker.state === 'redundant' || worker.state === 'activated') r();
					};
					worker.addEventListener('statechange', check);
					setTimeout(r, 10_000);
				});
			return { active: !!reg?.active };
		});
		expect(state.active).toBe(false);
		const dump = await cacheDump(page);
		expect(
			dump.filter((e) => e.type.includes('html') && new URL(e.url).pathname !== '/offline.html')
		).toEqual([]);
		expect(dump.find((e) => new URL(e.url).pathname === '/offline.css')).toBeUndefined();
		await context.unroute('**/offline.css');
		// With the redirect gone, the next load installs normally and stores the real stylesheet.
		await page.reload();
		await serviceWorkerReady(page);
		const css = (await cacheDump(page)).find((e) => new URL(e.url).pathname === '/offline.css');
		expect(css?.type).toContain('text/css');
		await context.close();
	});

	test('a cross-origin redirect (Cloudflare Access login) during install fails the install: nothing stored', async ({
		browser
	}, testInfo) => {
		desktopOnly(testInfo);
		const context = await browser.newContext({ baseURL: ORIGIN, storageState: SIGNED_OUT });
		await context.route('**/offline.html', (route) =>
			route.fulfill({
				status: 302,
				headers: { location: 'https://team.example.test/cdn-cgi/access/login' }
			})
		);
		await context.route('https://team.example.test/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Access login</title>' })
		);
		const page = await context.newPage();
		await page.goto('/login');
		const state = await page.evaluate(async () => {
			const reg = await navigator.serviceWorker.getRegistration();
			const worker = reg?.installing ?? reg?.waiting ?? reg?.active;
			if (worker && worker.state !== 'redundant' && worker.state !== 'activated')
				await new Promise<void>((r) => {
					const check = () => {
						if (worker.state === 'redundant' || worker.state === 'activated') r();
					};
					worker.addEventListener('statechange', check);
					setTimeout(r, 10_000);
				});
			return { state: worker?.state ?? 'none', active: !!reg?.active };
		});
		expect(state.active).toBe(false);
		const dump = await cacheDump(page);
		expect(dump.filter((e) => e.body.includes('Access login'))).toEqual([]);
		await context.close();
	});
});

test.describe('static paths with html_handling "none"', () => {
	test.use({ storageState: SIGNED_OUT });

	test('no server file, index or listing is served; SSR routes are not shadowed', async ({
		request
	}, testInfo) => {
		desktopOnly(testInfo);
		for (const path of [
			'/_worker.js',
			'/_headers',
			'/_routes.json',
			'/_redirects',
			'/.assetsignore',
			'/index.html',
			'/login.html',
			'/_app/',
			'/_app/immutable/',
			'/fonts/',
			'/icons/',
			'/offline.html/',
			'/offline'
		]) {
			const res = await request.get(path, { maxRedirects: 0 });
			const body = await res.text();
			expect(res.status(), path).not.toBe(200);
			expect(body, path).not.toMatch(
				/export default|addEventListener\('fetch'|Content-Security-Policy:|_worker\.js/
			);
		}
		// The sign-in page still comes from the Worker with its own CSP, not from assets.
		const login = await request.get('/login');
		expect(login.status()).toBe(200);
		expect(login.headers()['content-security-policy']).toMatch(/script-src/);
		// The worker answer carries no header widening its scope, and is not cached by the browser.
		const sw = await request.get('/service-worker.js');
		expect(sw.headers()['service-worker-allowed']).toBeUndefined();
		expect(sw.headers()['cache-control']).toBe('no-cache');
		expect(sw.headers()['content-type']).toMatch(/javascript/);
		expect(sw.headers()['access-control-allow-origin']).toBeUndefined();
		const manifest = await request.get('/manifest.webmanifest');
		expect(manifest.headers()['access-control-allow-origin']).toBeUndefined();
	});
});

test.describe('offline page', () => {
	test('served from the cache for any page, keeps its own CSP and cannot be framed; carries nothing of the page asked for', async ({
		page,
		context
	}, testInfo) => {
		desktopOnly(testInfo);
		await page.goto('/account');
		await serviceWorkerReady(page);
		await context.setOffline(true);
		for (const path of [
			'/projects/whatever',
			'/account?x=<script>alert(1)</script>',
			'/kb/1#frag'
		]) {
			const res = await page.goto(path);
			const h = res!.headers();
			expect(h['content-security-policy'], path).toContain("script-src 'none'");
			expect(h['content-security-policy'], path).toContain("frame-ancestors 'none'");
			expect(h['x-frame-options'], path).toBe('DENY');
			const html = await page.content();
			expect(html).not.toContain(ADMIN!.email);
			expect(html).not.toContain('<script');
			expect(html).not.toContain('alert(1)');
		}
		await context.setOffline(false);
	});
});

test.describe('handshake', () => {
	test('SKIP_WAITING spam with no waiting worker changes nothing; foreign message shapes are ignored', async ({
		page
	}, testInfo) => {
		desktopOnly(testInfo);
		await page.goto('/');
		await serviceWorkerReady(page);
		const before = (await cacheDump(page)).length;
		const result = await page.evaluate(async () => {
			let changes = 0;
			navigator.serviceWorker.addEventListener('controllerchange', () => changes++);
			const c = navigator.serviceWorker.controller!;
			for (let i = 0; i < 200; i++) c.postMessage({ type: 'SKIP_WAITING' });
			for (const m of [
				'SIGNED_OUT',
				{ type: 'signed_out' },
				{ type: ['SIGNED_OUT'] },
				{ kind: 'SIGNED_OUT' }
			])
				c.postMessage(m);
			await new Promise((r) => setTimeout(r, 1_000));
			return { changes, keys: (await caches.keys()).length };
		});
		expect(result.changes).toBe(0);
		expect(result.keys).toBe(1);
		expect((await cacheDump(page)).length).toBe(before);
	});
});

test.describe('two people, one browser', () => {
	test.use({ storageState: SIGNED_OUT });

	test('Safari-like (Clear-Site-Data ignored): after A signs out and B signs in, nothing of A is in any store', async ({
		browser
	}, testInfo) => {
		desktopOnly(testInfo);
		const { context, page } = await signedIn(browser, MEMBER!);
		// Safari ignores Clear-Site-Data: take it off the sign-out answer.
		await context.route('**/logout', async (route) => {
			const res = await route.fetch({ maxRedirects: 0 });
			const headers = { ...res.headers() };
			delete headers['clear-site-data'];
			await route.fulfill({ response: res, headers });
		});
		await serviceWorkerReady(page);
		for (const path of ['/account', '/my-tasks', '/notifications', '/people'])
			await page.goto(path);
		await page.locator('aside.sidebar').getByRole('button', { name: 'Sign out' }).click();
		await expect(page).toHaveURL(/\/login/);
		// The SIGNED_OUT message emptied the cache though Clear-Site-Data did not run, then downloaded the static shell
		// again (I1): nothing in it is a page, and nothing holds A's data.
		await expect
			.poll(async () =>
				(await cacheDump(page)).filter(
					(e) => e.type.includes('html') && new URL(e.url).pathname !== '/offline.html'
				)
			)
			.toEqual([]);
		for (const e of await cacheDump(page)) expect(e.body).not.toContain(MEMBER!.email);

		await page.getByLabel('E-mail').fill(ADMIN!.email);
		await page.getByLabel('Password').fill(SEED_PASSWORD);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(`${ORIGIN}/`);
		const stores = await page.evaluate(async () => ({
			local: JSON.stringify({ ...localStorage }),
			session: JSON.stringify({ ...sessionStorage }),
			dbs: (await indexedDB.databases()).map((d) => d.name)
		}));
		expect(stores.local).not.toContain(MEMBER!.email);
		expect(stores.session).not.toContain(MEMBER!.email);
		expect(stores.dbs).toEqual([]);
		for (const e of await cacheDump(page)) expect(e.body).not.toContain(MEMBER!.email);
		// Back to A's pages in history: each is fetched again and shows B (no-store, never cached).
		await page.goBack();
		await page.goto('/account');
		await expect(page.locator('main').getByText(ADMIN!.email)).toBeVisible();
		expect(await page.content()).not.toContain(MEMBER!.email);
		await context.close();
	});

	test('INFO: a sign-out sent offline wipes the cache but the session stays valid on the server', async ({
		browser
	}, testInfo) => {
		desktopOnly(testInfo);
		const { context, page } = await signedIn(browser, MEMBER!);
		await serviceWorkerReady(page);
		await context.route('**/logout', (route) => route.abort('internetdisconnected'));
		await page
			.locator('aside.sidebar')
			.getByRole('button', { name: 'Sign out' })
			.click()
			.catch(() => {});
		// The wipe ran (and the static shell was downloaded again, I1): nothing of the member is cached.
		await expect
			.poll(async () =>
				(await cacheDump(page).catch(() => [])).some((e) => e.body.includes(MEMBER!.email))
			)
			.toBe(false);
		await context.unroute('**/logout');
		await page.goto('/account');
		await expect(page.locator('main').getByText(MEMBER!.email)).toBeVisible();
		await context.close();
	});
});

test.describe('offline form guard', () => {
	test.use({ storageState: SIGNED_OUT });

	test('fixed (L2): a save that reached the server but lost its answer says it may have been saved', async ({
		browser
	}, testInfo) => {
		desktopOnly(testInfo);
		const { context, page } = await signedIn(browser, MEMBER!);
		await page.goto('/account');
		const form = page.locator('form[action="?/name"]');
		const name = form.getByLabel('Name');
		const original = await name.inputValue();
		const changed = `${original} RB20`;
		await context.route('**/account?/name', async (route) => {
			await route.fetch(); // the server applies the change
			await route.abort('internetdisconnected'); // the answer never arrives
		});
		await name.fill(changed);
		await form.getByRole('button', { name: 'Save name' }).click();
		await expect(form.getByRole('alert')).toHaveText(
			'The connection dropped. Your change may have been saved. Reload the page to check before trying again.'
		);
		await context.unroute('**/account?/name');
		await page.reload();
		await expect(form.getByLabel('Name')).toHaveValue(changed);
		// Put the seed name back.
		await form.getByLabel('Name').fill(original);
		await form.getByRole('button', { name: 'Save name' }).click();
		await expect(form.getByText('Name saved.')).toBeVisible();
		await context.close();
	});

	test('a cross-site POST is still refused with the wrapper in place (CSRF is server-side)', async ({
		request
	}, testInfo) => {
		desktopOnly(testInfo);
		const res = await request.post('/account?/name', {
			headers: {
				origin: 'https://evil.example.test',
				'content-type': 'application/x-www-form-urlencoded'
			},
			data: 'name=x',
			maxRedirects: 0
		});
		expect(res.status()).toBe(403);
	});
});
