import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers';
import { SEED_PASSWORD, SEED_USERS } from '../scripts/seed-data';

/**
 * QA proofs for RB-01 (docs/features/rb-01-projects-tasks/QA_REPORT.md; moved here from test/qa/rb01.pw.ts) that
 * projects.spec.ts does not cover: mouse drag, the no-JS move form, inert Markdown, access, overdue, key rules, raw
 * POSTs, labels and phone touch targets.
 */

const isPhone = (w: number) => w < 768;
const KEY = (info: { project: { name: string } }) =>
	'QA' +
	info.project.name
		.replace(/[^a-z0-9]/gi, '')
		.toUpperCase()
		.slice(-4);

async function ensureProject(page: Page, key: string) {
	const r = await page.goto(`/projects/${key}`);
	if (r?.status() === 200) return;
	await page.goto('/projects/new');
	await page.getByLabel('Key').fill(key.toLowerCase());
	await page.getByLabel('Name').fill(`QA ${key}`);
	await page.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(`/projects/${key}`);
}
async function addTask(
	page: Page,
	key: string,
	title: string,
	f: { due?: string; desc?: string; status?: string } = {}
) {
	await page.goto(`/projects/${key}/tasks/new${f.status ? `?status=${f.status}` : ''}`);
	await page.getByLabel('Title').fill(title);
	if (f.due) await page.getByLabel('Due date').fill(f.due);
	if (f.desc) await page.getByRole('textbox', { name: 'Description' }).fill(f.desc);
	await page.getByRole('button', { name: 'Create task' }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${key}/tasks/\\d+$`));
	return Number(page.url().split('/').pop());
}
const titles = (page: Page, status: string) =>
	page.locator(`section[data-column="${status}"] [data-card] a`).allTextContents();

test('mouse drag: between two cards, across columns, persists after reload', async ({
	page
}, info) => {
	test.skip(isPhone(page.viewportSize()!.width), 'mouse: desktop');
	const key =
		KEY(info) +
		'M' +
		Date.now()
			.toString(36)
			.slice(-3)
			.toUpperCase()
			.replace(/[^A-Z]/g, 'Z');
	await ensureProject(page, key);
	for (const t of ['one', 'two', 'three']) await addTask(page, key, `Card ${t}`);
	await page.goto(`/projects/${key}?view=board`);
	const handle = (n: number) => page.getByRole('button', { name: `Move ${key}-${n}` });
	const card = (n: number) =>
		page
			.locator(`[data-card]:has([data-handle])`)
			.filter({ hasText: `Card ${['', 'one', 'two', 'three'][n]}` });
	expect(await titles(page, 'todo')).toEqual(expect.arrayContaining(['Card one']));
	const startOrder = (await titles(page, 'todo')).filter((t) => /^Card/.test(t));
	// Card three, by its handle, onto the upper half of card one: it becomes the first card.
	const hb = (await handle(3).boundingBox())!;
	const target = (await card(1).boundingBox())!;
	await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
	await page.mouse.down();
	await page.mouse.move(hb.x + 20, hb.y + 20, { steps: 4 });
	await page.mouse.move(target.x + target.width / 2, target.y + 4, { steps: 10 });
	const moved = page.waitForResponse(
		(r) => r.url().includes('/move') && r.request().method() === 'POST'
	);
	await page.mouse.up();
	expect((await moved).ok()).toBe(true);
	await expect
		.poll(async () => (await titles(page, 'todo')).filter((t) => /^Card/.test(t)))
		.not.toEqual(startOrder);
	const afterDrag = (await titles(page, 'todo')).filter((t) => /^Card/.test(t));
	expect(afterDrag[0]).toBe('Card three');
	await page.reload();
	expect((await titles(page, 'todo')).filter((t) => /^Card/.test(t))).toEqual(afterDrag);
	// Across columns: card one to In progress.
	const h1 = (await handle(1).boundingBox())!;
	const column = (await page.locator('section[data-column="in_progress"]').boundingBox())!;
	await page.mouse.move(h1.x + h1.width / 2, h1.y + h1.height / 2);
	await page.mouse.down();
	await page.mouse.move(h1.x + 20, h1.y + 20, { steps: 4 });
	await page.mouse.move(column.x + column.width / 2, column.y + 120, { steps: 15 });
	const movedAcross = page.waitForResponse(
		(r) => r.url().includes('/move') && r.request().method() === 'POST'
	);
	await page.mouse.up();
	expect((await movedAcross).ok()).toBe(true);
	await expect.poll(() => titles(page, 'in_progress')).toContain('Card one');
	await page.reload();
	expect(await titles(page, 'in_progress')).toContain('Card one');
	expect(await titles(page, 'todo')).not.toContain('Card one');
});

test('no JS: per-card move form moves to chosen status, top/bottom', async ({ browser }, info) => {
	const key = KEY(info) + 'N';
	const setup = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
	const sp = await setup.newPage();
	await ensureProject(sp, key);
	await addTask(sp, key, 'NoJS a');
	await addTask(sp, key, 'NoJS b');
	await setup.close();
	const ctx = await browser.newContext({
		javaScriptEnabled: false,
		storageState: 'e2e/.auth/admin.json',
		viewport: { width: 1280, height: 800 }
	});
	const page = await ctx.newPage();
	await page.goto(`/projects/${key}?view=board`);
	const cardA = page.locator('[data-card]', { hasText: 'NoJS a' }).first();
	await cardA.locator('details.move summary').click();
	await cardA.locator('form.move-form select[name=status]').selectOption('in_progress');
	await cardA.locator('form.move-form select[name=place]').selectOption('top');
	await cardA.locator('form.move-form button[type=submit]').click();
	await expect(page.locator('section[data-column="in_progress"]')).toContainText('NoJS a');
	await expect(page.locator('section[data-column="todo"]')).not.toContainText('NoJS a');
	await ctx.close();
});

test('access: signed out redirects to login; disabled member loses access at once', async ({
	browser,
	baseURL
}) => {
	test.skip(test.info().project.name !== 'desktop', 'once');
	const origin = new URL(baseURL!).origin;
	const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const p = await anon.newPage();
	for (const path of [
		'/projects',
		'/projects/new',
		'/my-tasks',
		'/projects/OPS',
		'/projects/OPS/tasks/1'
	]) {
		await p.goto(path);
		await expect(p, path).toHaveURL(/\/login/);
	}
	const r = await anon.request.post('/projects/new', {
		form: { key: 'ZZZ', name: 'x' },
		headers: { origin },
		maxRedirects: 0
	});
	expect([302, 303, 401, 403]).toContain(r.status());
	const r2 = await anon.request.post('/projects/QAXX/tasks/1?/delete', {
		form: { confirm: 'yes' },
		headers: { origin },
		maxRedirects: 0
	});
	expect([302, 303, 401, 403, 404]).toContain(r2.status());
	await anon.close();

	const member = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const mp = await member.newPage();
	await mp.goto('/login');
	await mp.getByLabel('E-mail').fill(SEED_USERS[1].email);
	await mp.getByLabel('Password').fill(SEED_PASSWORD);
	await mp.getByRole('button', { name: 'Sign in' }).click();
	await expect(mp).toHaveURL('/');
	expect((await mp.goto('/projects'))?.status()).toBe(200);
	const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
	const ap = await admin.newPage();
	const setStatus = (status: string) =>
		admin.request.post('/admin/users?/setStatus', {
			form: { userId: SEED_USERS[1].id, status },
			headers: { origin },
			maxRedirects: 0
		});
	try {
		await setStatus('disabled');
		await mp.goto('/projects');
		await expect(mp).toHaveURL(/\/login/);
		const post = await member.request.post('/projects/new', {
			form: { key: 'DISX', name: 'x' },
			headers: { origin },
			maxRedirects: 0
		});
		expect([302, 303, 401, 403]).toContain(post.status());
		expect((await ap.goto('/projects/DISX'))?.status()).toBe(404);
	} finally {
		await setStatus('active');
	}
	await member.close();
	await admin.close();
});

test('markdown description is inert; overdue only for open tasks', async ({ page }, info) => {
	const key = KEY(info) + 'X';
	await ensureProject(page, key);
	const evil =
		'<script>window.__pwn=1</script> <img src=x onerror="window.__pwn=2"> [bad](javascript:alert(1)) [ent](&#106;avascript:alert(1)) ![i](data:text/html,x)';
	const n = await addTask(page, key, 'Evil', { desc: evil, due: '2001-01-01' });
	await page.goto(`/projects/${key}/tasks/${n}`);
	expect(
		await page.locator('section.main script, section.main img, section.main [onerror]').count()
	).toBe(0);
	expect(await page.locator('section.main .markdown').innerText()).toContain('<script>');
	expect(
		await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn)
	).toBeUndefined();
	expect(await page.locator('main a[href^="javascript" i]').count()).toBe(0);
	await page.goto(`/projects/${key}`);
	await expect(page.locator('time.due.overdue')).toHaveCount(1);
	// Closing it removes the overdue style.
	await page.goto(`/projects/${key}/tasks/${n}`);
	await Promise.all([
		page.waitForResponse((r) => r.request().method() === 'POST'),
		page.getByLabel('Status').selectOption('done')
	]);
	await page.goto(`/projects/${key}`);
	await expect(page.locator('time.due.overdue')).toHaveCount(0);
});

test('routes: case redirect, bad numbers 404, new-task preset, key errors, layouts fit', async ({
	page
}, info) => {
	const key = KEY(info) + 'R';
	await ensureProject(page, key);
	const resp = await page.goto(`/projects/${key.toLowerCase()}`);
	await expect(page).toHaveURL(`/projects/${key}`);
	expect(resp?.request().redirectedFrom()?.url()).toContain(key.toLowerCase());
	for (const n of ['0', 'abc', '99999999999', '01', '-1'])
		expect((await page.goto(`/projects/${key}/tasks/${n}`))?.status(), n).toBe(404);
	expect((await page.goto('/projects/NOPE'))?.status()).toBe(404);
	for (const path of [
		'/projects',
		'/projects/new',
		`/projects/${key}`,
		`/projects/${key}?view=board`,
		`/projects/${key}/settings`,
		`/projects/${key}/tasks/new?status=in_review`,
		'/my-tasks',
		'/my-tasks?closed=1'
	]) {
		expect((await page.goto(path))?.status(), path).toBe(200);
		await expectNoHorizontalOverflow(page);
	}
	await page.goto(`/projects/${key}/tasks/new?status=in_review`);
	await expect(page.getByLabel('Status')).toHaveValue('in_review');
	// Bad keys, a pasted 11-character one included (no maxlength cuts it), each show a field error.
	for (const bad of ['A', '1AB', 'ABCDEFGHIJK', 'A-B', 'ÄB', 'new']) {
		await page.goto('/projects/new');
		await page.getByLabel('Key').fill(bad);
		await page.getByLabel('Name').fill('x');
		await page.getByRole('button', { name: 'Create project' }).click();
		await expect(page, bad).toHaveURL(/projects\/new/);
		await expect(page.locator('.field-error').first(), bad).toHaveText(/2 to 10 letters|reserved/);
	}
});

test('raw POSTs: 11-char key refused server-side; key immutable; bogus afterTaskId ignored', async ({
	page,
	baseURL
}, info) => {
	test.skip(info.project.name !== 'desktop', 'once');
	const origin = { origin: new URL(baseURL!).origin };
	const r = await page.request.post('/projects/new', {
		form: { key: 'ABCDEFGHIJK', name: 'long' },
		headers: origin,
		maxRedirects: 0
	});
	expect(r.status(), 'form action answers with fail data, not a redirect').not.toBe(303);
	expect((await page.goto('/projects/ABCDEFGHIJK'))?.status()).toBe(404);
	const key = 'QAIMM';
	await ensureProject(page, key);
	await addTask(page, key, 'immut');
	await page.goto(`/projects/${key}/settings`);
	const upd = await page.locator('input[name=expectedUpdatedAt]').first().inputValue();
	const res = await page.request.post(`/projects/${key}/settings?/update`, {
		form: { name: 'renamed', description: '', leadId: '', key: 'HACK', expectedUpdatedAt: upd },
		headers: origin,
		maxRedirects: 0
	});
	expect(res.status()).toBeLessThan(500);
	expect((await page.goto('/projects/HACK'))?.status()).toBe(404);
	expect((await page.goto(`/projects/${key}`))?.status()).toBe(200);
	// A bogus afterTaskId (unknown uuid, not a uuid, an injection attempt) never answers 5xx.
	await page.goto(`/projects/${key}?view=board`);
	const taskId = await page.locator('[data-card]').first().getAttribute('data-card');
	for (const after of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', "' OR 1=1 --"]) {
		const m = await page.request.post(`/projects/${key}?/move`, {
			form: { taskId: taskId!, status: 'done', afterTaskId: after },
			headers: { ...origin, accept: 'application/json', 'x-sveltekit-action': 'true' }
		});
		expect(m.status(), after).toBeLessThan(500);
	}
});

test('every visible form control has a label; touch targets 44px on phones; no overflow', async ({
	page
}, info) => {
	const key = KEY(info) + 'L';
	await ensureProject(page, key);
	const n = await addTask(page, key, 'Label audit', { due: '2001-01-01' });
	const paths = [
		'/projects',
		'/projects/new',
		`/projects/${key}`,
		`/projects/${key}?view=board`,
		`/projects/${key}/settings`,
		`/projects/${key}/tasks/new`,
		`/projects/${key}/tasks/${n}`,
		'/my-tasks'
	];
	for (const path of paths) {
		await page.goto(path);
		const bad = await page.evaluate(() =>
			[...document.querySelectorAll('input:not([type=hidden]), select, textarea, button')]
				.filter((el) => (el as HTMLElement).offsetParent !== null)
				.filter((el) => {
					const e = el as HTMLInputElement;
					const name =
						e.getAttribute('aria-label') ||
						e.getAttribute('aria-labelledby') ||
						(e.labels && e.labels.length) ||
						e.textContent?.trim() ||
						e.getAttribute('title');
					return !name;
				})
				.map((el) => el.outerHTML.slice(0, 120))
		);
		expect(bad, path).toEqual([]);
		await expectNoHorizontalOverflow(page);
		if (isPhone(page.viewportSize()!.width)) {
			const small = await page.evaluate(() =>
				[
					...document.querySelectorAll(
						'main a, main button, main select, main input:not([type=hidden]):not([type=checkbox]):not([type=radio]), main summary'
					)
				]
					.filter(
						(el) =>
							(el as HTMLElement).offsetParent !== null &&
							!el.closest('.sr-only') &&
							!(
								el.closest('p, li, td, .markdown') &&
								el.tagName === 'A' &&
								!el.closest('.row, .card, .task, [data-card]')
							)
					)
					.map((el) => ({ el: el.outerHTML.slice(0, 90), h: el.getBoundingClientRect().height }))
					.filter((x) => x.h < 44)
			);
			expect(small, path).toEqual([]);
		}
	}
});
