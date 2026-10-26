import { expect, test, type Browser, type Page } from '@playwright/test';
import { SEED_PASSWORD, SEED_USERS } from '../scripts/seed-data';

/**
 * QA proofs for RB-03 (docs/features/rb-03-comments-notifications/QA_REPORT.md): raw-POST authorization, bounds,
 * injection, throttle, forged ids, plus the phone tab-bar overlap probe. Desktop project only for the API proofs.
 */
const [, MEMBER, QA_ADMIN] = SEED_USERS;
const isPhone = (w: number) => w < 768;
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ZERO = '00000000-0000-4000-8000-000000000000';

async function signedIn(browser: Browser, baseURL: string, user: { email: string }) {
	const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	await page.goto('/login');
	await page.getByLabel('E-mail').fill(user.email);
	await page.getByLabel('Password').fill(SEED_PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
	return { context, page };
}
const memberPage = (browser: Browser, baseURL: string) => signedIn(browser, baseURL, MEMBER);

async function newKbPage(page: Page): Promise<string> {
	await page.goto('/kb/new');
	await page.getByLabel('Title', { exact: true }).fill(`QA3 ${uniq()}`);
	await page.getByLabel('Body', { exact: true }).fill('qa page');
	await page
		.getByRole('button', { name: 'Create page' })
		.evaluate((el) => el.scrollIntoView({ block: 'center' }));
	await page.getByRole('button', { name: 'Create page' }).click();
	await page.waitForURL(/\/kb\/[0-9a-f-]{36}\?notice=created$/);
	return new URL(page.url()).pathname;
}

test('raw HTTP: auth, bounds, XSS, authorization, throttle, forged ids', async ({
	browser,
	baseURL,
	playwright
}, info) => {
	test.skip(info.project.name !== 'desktop', 'once');
	test.setTimeout(120_000);
	// Its own admin (QA F1): the shared seeded admin's comment budget is spent by parallel specs, which turned the
	// 409/403 probes below into 429s.
	const { context: qaContext, page } = await signedIn(browser, baseURL!, QA_ADMIN);
	const origin = { origin: new URL(baseURL!).origin, accept: 'text/html' };
	const post = (
		p: Page | { request: Page['request'] },
		url: string,
		form: Record<string, string>
	) => p.request.post(url, { form, headers: origin, maxRedirects: 0 });

	// 1. signed out
	void playwright;
	const f = (u: string, init: RequestInit = {}) =>
		fetch(new URL(u, baseURL!), { redirect: 'manual', ...init });
	const anon = {
		get: async (u: string) => f(u),
		post: async (u: string, o: { form: Record<string, string>; headers: Record<string, string> }) =>
			f(u, { method: 'POST', body: new URLSearchParams(o.form), headers: o.headers }),
		dispose: async () => {}
	};
	const mentionsAnon = await anon.get('/api/mentions?q=a');
	expect([401, 302, 303]).toContain(mentionsAnon.status);
	const notifAnon = await anon.get('/notifications');
	expect([302, 303, 401]).toContain(notifAnon.status);
	const path = await newKbPage(page);
	const id = path.split('/').pop()!;
	const anonPost = await anon.post(`${path}?/commentCreate`, {
		form: { body: 'x' },
		headers: origin
	});
	expect(anonPost.status, 'signed-out comment POST').not.toBe(200);
	expect([302, 303, 401, 403]).toContain(anonPost.status);
	const anonRead = await anon.post('/notifications?/readAll', { form: {}, headers: origin });
	expect([302, 303, 401, 403]).toContain(anonRead.status);

	// 17. mentions API
	const m = await page.request.get('/api/mentions?q=');
	expect(m.status()).toBe(200);
	expect(m.headers()['cache-control']).toBe('private, no-store');
	const list = (await m.json()).users as { id: string; name: string }[];
	expect(list.length).toBeLessThanOrEqual(8);
	for (const u of list) expect(Object.keys(u).sort()).toEqual(['id', 'name']);
	expect(JSON.stringify(list)).not.toContain('@example.test');
	expect((await page.request.get(`/api/mentions?q=${'a'.repeat(51)}`)).status()).toBe(400);
	expect((await page.request.get(`/api/mentions?q=${'a'.repeat(50)}`)).status()).toBe(200);
	const mx = (await (await page.request.get('/api/mentions?q=max')).json()).users;
	expect(mx.map((u: { id: string }) => u.id)).toContain(MEMBER.id);
	expect((await (await page.request.get("/api/mentions?q=%25_'")).json()).users).toEqual([]);

	// 2/3. bounds
	const okBody = async (b: string) =>
		(await post(page, `${path}?/commentCreate`, { body: b })).status();
	expect(await okBody(''), 'empty').toBe(400);
	expect(await okBody('   \n\t '), 'blank').toBe(400);
	expect(await okBody('\u0000\u0000'), 'NUL only').toBe(400);
	expect(await okBody('a'.repeat(10_001)), '10001').toBe(400);
	expect(await okBody('a'.repeat(10_000)), '10000').toBe(303);
	expect(await okBody('b'), '1 char').toBe(303);
	// malformed / missing target
	expect((await post(page, `/kb/not-a-uuid?/commentCreate`, { body: 'x' })).status()).toBe(404);
	expect((await post(page, `/kb/${ZERO}?/commentCreate`, { body: 'x' })).status()).toBe(404);
	expect((await post(page, `/projects/ZZZZZ/tasks/1?/commentCreate`, { body: 'x' })).status()).toBe(
		404
	);

	// 4. XSS inert
	const payload =
		'<script>window.__x=1</script> [a](javascript:alert(1)) <img src=x onerror=alert(1)> [b](data:text/html,x)';
	expect(await okBody(payload)).toBe(303);
	await page.goto(path);
	const html = await page.locator('#comments').innerHTML();
	expect(html).not.toMatch(/<script/i);
	expect(
		await page
			.locator('#comments .markdown img, #comments .markdown [onerror], #comments .markdown script')
			.count()
	).toBe(0);
	expect(
		await page.locator('#comments a[href^="javascript:" i], #comments a[href^="data:" i]').count()
	).toBe(0);
	expect(html).toContain('&lt;script&gt;');
	expect(await page.evaluate(() => (window as unknown as { __x?: number }).__x)).toBeUndefined();

	// 5/6/7/9/10 permissions with a second user
	const { context, page: mp } = await memberPage(browser, baseURL!);
	const mine = `admin comment ${uniq()}`;
	await post(page, `${path}?/commentCreate`, { body: mine });
	await page.goto(path);
	const li = page.locator('#comments li.comment', { hasText: mine });
	const cid = (await li.getAttribute('id'))!.replace('comment-', '');
	const upd = await page.locator(`#comment-${cid}`).evaluate((el) => el.innerHTML);
	expect(upd).toBeTruthy();
	// member (not author) edit => 403, delete => 403
	expect(
		(
			await post(mp, `${path}?/commentEdit`, {
				commentId: cid,
				body: 'hax',
				expectedUpdatedAt: '1'
			})
		).status()
	).toBe(403);
	expect((await post(mp, `${path}?/commentDelete`, { commentId: cid })).status()).toBe(403);
	await page.goto(path);
	await expect(page.locator(`#comment-${cid}`)).toContainText(mine);
	// admin edit of member's comment => 403 ; admin delete of member's => ok
	(
		await post(mp, `${path}?/commentCreate`, {
			body: `member says ${uniq()} @[Quinn](user:${QA_ADMIN.id})`
		})
	).status();
	await page.goto(path);
	const mli = page.locator('#comments li.comment', { hasText: 'member says' }).last();
	const mid = (await mli.getAttribute('id'))!.replace('comment-', '');
	expect(
		(
			await post(page, `${path}?/commentEdit`, {
				commentId: mid,
				body: 'admin rewrites',
				expectedUpdatedAt: '1'
			})
		).status(),
		'admin edit others'
	).toBe(403);
	// stale expectedUpdatedAt by author => 409
	const stale = await post(page, `${path}?/commentEdit`, {
		commentId: cid,
		body: 'changed',
		expectedUpdatedAt: '1'
	});
	expect(stale.status()).toBe(409);
	// good edit, with "edited" label
	await page.goto(`${path}?cedit=${cid}`);
	const exp = await page.locator(`#comment-${cid} input[name=expectedUpdatedAt]`).inputValue();
	expect(
		(
			await post(page, `${path}?/commentEdit`, {
				commentId: cid,
				body: 'edited ok',
				expectedUpdatedAt: exp
			})
		).status()
	).toBe(303);
	await page.goto(path);
	await expect(page.locator(`#comment-${cid}`)).toContainText('edited ok');
	await expect(page.locator(`#comment-${cid}`)).toContainText(/edited/i);
	// admin delete member comment
	expect((await post(page, `${path}?/commentDelete`, { commentId: mid })).status()).toBe(303);
	expect(
		(await post(page, `${path}?/commentDelete`, { commentId: mid })).status(),
		'idempotent'
	).toBe(303);
	await page.goto(path);
	await expect(page.locator(`#comment-${mid}`)).toHaveCount(0);
	// edit of deleted => 404
	expect(
		(
			await post(page, `${path}?/commentEdit`, {
				commentId: mid,
				body: 'z',
				expectedUpdatedAt: '1'
			})
		).status()
	).toBe(404);

	// 13 forged mark-read: admin has a mention notification from member; member forging admin's notif id
	await page.goto('/notifications');
	const rowIds = await page
		.locator('input[name=id]')
		.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
	expect(rowIds.length).toBeGreaterThan(0);
	const before = await page.locator('.dot, [data-unread]').count();
	const forged = await post(mp, '/notifications?/read', { id: rowIds[0]! });
	expect(forged.status()).toBeLessThan(500);
	await page.goto('/notifications');
	expect(await page.locator('.dot, [data-unread]').count(), 'forged id changed nothing').toBe(
		before
	);
	await post(mp, '/notifications?/readAll', {});
	await page.goto('/notifications');
	expect(
		await page.locator('.dot, [data-unread]').count(),
		'member readAll leaves admin rows'
	).toBe(before);
	expect((await post(mp, '/notifications?/read', { id: 'nope' })).status()).toBe(404);

	// 18 throttle (member; 20/min) : 21st refused, text kept
	const tpath = path;
	let last = 0;
	let lastBody = '';
	for (let i = 0; i < 25; i++) {
		lastBody = `thr ${uniq()} ${i}`;
		const r = await post(mp, `${tpath}?/commentCreate`, { body: lastBody });
		last = r.status();
		if (last === 429) {
			expect(await r.text()).toContain(lastBody);
			break;
		}
	}
	expect(last, 'throttle reached').toBe(429);
	await mp.goto(tpath);
	await expect(mp.locator('#comments')).not.toContainText(lastBody);
	await context.close();
	await qaContext.close();
	await anon.dispose();
	void id;
});

test('phones: submit button vs fixed tab bar (JS on/off), comment form and KB editor', async ({
	page
}, info) => {
	test.skip(!isPhone(page.viewportSize()!.width), 'phones');
	const out: string[] = [];
	for (const js of [true, false]) {
		const ctx = await page
			.context()
			.browser()!
			.newContext({
				...info.project.use,
				javaScriptEnabled: js,
				storageState: 'e2e/.auth/admin.json'
			} as never);
		const p = await ctx.newPage();
		const path = await newKbPage(p).catch(async () => {
			// JS off: creation form works without JS too
			return new URL(p.url()).pathname;
		});
		for (const [name, url, btn] of [
			['comment', path, 'Comment'],
			['kb-new', '/kb/new', 'Create page'],
			['kb-edit', `${path}/edit`, 'Save']
		] as const) {
			await p.goto(url);
			const b = p.getByRole('button', { name: btn, exact: true }).last();
			if ((await b.count()) === 0) continue;
			// (a) scrolled to the very bottom of the page
			await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
			// (b) keyboard focus on the button, as Tab would do (browser "nearest" scroll)
			await p.evaluate(() => window.scrollTo(0, 0));
			await b.focus();
			const r = await p.evaluate((n) => {
				const bar = document.querySelector('.tabbar')!.getBoundingClientRect();
				const el = [...document.querySelectorAll('button')]
					.filter((x) => x.textContent?.trim() === n)
					.pop()!;
				const rc = el.getBoundingClientRect();
				return { btnBottom: Math.round(rc.bottom), barTop: Math.round(bar.top) };
			}, btn);
			out.push(
				`${info.project.name} js=${js} ${name}: focused button bottom=${r.btnBottom} tabbarTop=${r.barTop} overlap=${r.btnBottom > r.barTop}`
			);
			// (c) bottom of page: button clear of bar
			await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
			const r2 = await p.evaluate((n) => {
				const bar = document.querySelector('.tabbar')!.getBoundingClientRect();
				const el = [...document.querySelectorAll('button')]
					.filter((x) => x.textContent?.trim() === n)
					.pop()!;
				return {
					btnBottom: Math.round(el.getBoundingClientRect().bottom),
					barTop: Math.round(bar.top)
				};
			}, btn);
			out.push(
				`${info.project.name} js=${js} ${name}: page-bottom btnBottom=${r2.btnBottom} tabbarTop=${r2.barTop}`
			);
			expect(r2.btnBottom, `${name} reachable above bar at page bottom`).toBeLessThanOrEqual(
				r2.barTop
			);
		}
		await ctx.close();
	}
	console.log(out.join('\n'));
	info.annotations.push({ type: 'probe', description: out.join(' | ') });
});
