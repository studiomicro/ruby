import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow, submitReport } from './helpers';
import { SEED_PASSWORD, SEED_USERS } from '../scripts/seed-data';

/**
 * RB-12 QA proofs: refusals for signed-out and member, filters and sorting on /issues, bulk cap and all-or-nothing,
 * archived projects, Report idempotency (with and without JavaScript), team labels across projects, the type in
 * search and My tasks, and the three phone widths with a long title. Data tests run on the desktop project only
 * (one shared server); the layout test runs on every project.
 */
test.describe.configure({ mode: 'serial' });

const ORIGIN = {
	accept: 'text/html',
	origin: 'http://localhost:' + (process.env.RUBY_E2E_PORT ?? '4317')
};
const ADMIN_ID = SEED_USERS[0].id;
const RUN = Date.now().toString(36).slice(-4);
const desktopOnly = (info: { project: { name: string } }) =>
	test.skip(info.project.name !== 'desktop', 'data flow: desktop only');

async function makeProject(page: Page, key: string) {
	await page.goto('/projects/new');
	await page.getByLabel('Key').fill(key);
	await page.getByLabel('Name').fill(`QA ${key}`);
	await page.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(`/projects/${key}`);
}

async function report(
	page: Page,
	key: string,
	title: string,
	opts: { type?: string; priority?: string } = {}
) {
	await page.goto(`/issues/new?project=${key}`);
	await page.getByLabel('Title').fill(title);
	if (opts.type) await page.getByLabel('Type').selectOption(opts.type);
	if (opts.priority) await page.getByLabel('Priority').selectOption(opts.priority);
	await submitReport(page);
	await expect(page).toHaveURL(new RegExp(`/projects/${key}/tasks/\\d+\\?reported=`));
}

/** Posts the bulk action as the enhanced client does and returns the action result (type, status, data). */
async function bulk(page: Page, form: Record<string, string | string[]>) {
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(form))
		for (const x of Array.isArray(v) ? v : [v]) params.append(k, x);
	const r = await page.request.post('/issues?/bulk', {
		data: params.toString(),
		headers: {
			...ORIGIN,
			accept: 'application/json',
			'content-type': 'application/x-www-form-urlencoded',
			'x-sveltekit-action': 'true'
		}
	});
	const body = (await r.json()) as { type: string; status?: number; data?: string };
	return { type: body.type, status: body.status ?? r.status(), data: body.data ?? '' };
}

const titlesOn = async (page: Page, url: string) => {
	await page.goto(url);
	const raw = await page.locator('.wide tbody tr a[href*="/tasks/"]').allInnerTexts();
	return raw.map((t) => t.replace(/^[A-Z0-9]+-\d+:?\s*/, '').trim());
};
const taskIds = async (page: Page, url: string) => {
	await page.goto(url);
	return page
		.locator('.wide input[name="taskId"]')
		.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
};

const A = `QA${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}A`;
const B = `QA${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}B`;
const C = `QA${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}C`;

test('signed-out and member are refused', async ({ browser, baseURL }, info) => {
	desktopOnly(info);
	const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	for (const path of ['/issues', '/issues/new', '/issues/labels?project=ABC', '/admin/labels']) {
		const r = await anon.request.get(`${baseURL}${path}`, { maxRedirects: 0 });
		expect([302, 303, 401, 403], `${path} -> ${r.status()}`).toContain(r.status());
	}
	for (const path of ['/admin/labels?/create', '/issues?/bulk', '/issues/new']) {
		const r = await anon.request.post(`${baseURL}${path}`, {
			form: { name: 'x', color: 'blue' },
			headers: ORIGIN,
			maxRedirects: 0
		});
		expect([302, 303, 401, 403], `POST ${path} -> ${r.status()}`).toContain(r.status());
	}
	await anon.close();

	const member = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const p = await member.newPage();
	await p.goto(`${baseURL}/login`);
	await p.getByLabel('E-mail').fill(SEED_USERS[1].email);
	await p.getByLabel('Password').fill(SEED_PASSWORD);
	await p.getByRole('button', { name: 'Sign in' }).click();
	await expect(p).toHaveURL(`${baseURL}/`);
	expect((await member.request.get(`${baseURL}/admin/labels`)).status()).toBe(403);
	const post = await member.request.post(`${baseURL}/admin/labels?/create`, {
		form: { name: `Sneaky ${RUN}`, color: 'blue' },
		headers: ORIGIN
	});
	expect(post.status()).toBe(403);
	expect((await member.request.get(`${baseURL}/issues`)).status()).toBe(200);
	await member.close();
});

test('filters, combinations and sorting on /issues', async ({ page }, info) => {
	desktopOnly(info);
	await makeProject(page, A);
	await makeProject(page, B);
	await report(page, A, `A-bug-urgent ${RUN}`, { type: 'bug', priority: 'urgent' });
	await report(page, A, `A-feat-low ${RUN}`, { type: 'feature_request', priority: 'low' });
	await report(page, A, `A-imp-high ${RUN}`, { type: 'improvement', priority: 'high' });
	await report(page, B, `B-bug-low ${RUN}`, { type: 'bug', priority: 'low' });

	const both = `/issues?project=${A}&project=${B}`;
	expect(await titlesOn(page, both)).toHaveLength(4);
	let t = await titlesOn(page, `${both}&type=bug`);
	expect(t.sort()).toEqual([`A-bug-urgent ${RUN}`, `B-bug-low ${RUN}`]);
	t = await titlesOn(page, `${both}&type=bug&priority=low`);
	expect(t).toEqual([`B-bug-low ${RUN}`]);
	t = await titlesOn(page, `${both}&type=bug&type=improvement`);
	expect(t).toHaveLength(3);
	t = await titlesOn(page, `/issues?project=${A}&reporter=me`);
	expect(t).toHaveLength(3);
	t = await titlesOn(page, `${both}&assignee=none&status=backlog&priority=low`);
	expect(t.sort()).toEqual([`A-feat-low ${RUN}`, `B-bug-low ${RUN}`]);
	t = await titlesOn(page, `${both}&assignee=me`);
	expect(t).toHaveLength(0);
	await expect(page.getByText('No issues match these filters')).toBeVisible();
	// Sort by priority desc: urgent, high, then the lows.
	t = await titlesOn(page, `/issues?project=${A}&sort=priority&dir=desc`);
	expect(t).toEqual([`A-bug-urgent ${RUN}`, `A-imp-high ${RUN}`, `A-feat-low ${RUN}`]);
	t = await titlesOn(page, `/issues?project=${A}&sort=created&dir=asc`);
	expect(t[0]).toBe(`A-bug-urgent ${RUN}`);
	t = await titlesOn(page, `/issues?project=${A}&sort=updated`);
	expect(t[0]).toBe(`A-imp-high ${RUN}`);
	// Dates: today inclusive keeps everything, a past range keeps nothing.
	const today = new Date().toISOString().slice(0, 10);
	expect(
		await titlesOn(page, `${both}&created_from=${today}&created_to=${today}`)
	).not.toHaveLength(0);
	expect(await titlesOn(page, `${both}&created_to=2020-01-01`)).toHaveLength(0);
	// Invalid values dropped with a notice, no 500.
	const r = await page.goto(`${both}&type=epic&label=nope&created_from=2026-02-30`);
	expect(r?.status()).toBe(200);
	await expect(page.getByText(/Some filters were ignored/)).toBeVisible();
	const bad = await page.goto('/issues?page=abc');
	expect(bad?.status()).toBe(200);
});

test('Report: double submit is idempotent with and without JavaScript', async ({
	page,
	browser,
	baseURL
}, info) => {
	desktopOnly(info);
	// No JS: replay the same POST body twice.
	const ctx = await browser.newContext({
		javaScriptEnabled: false,
		storageState: info.project.use.storageState as string
	});
	const p = await ctx.newPage();
	await p.goto(`${baseURL}/issues/new?project=${A}`);
	const submissionId = await p.locator('input[name="submissionId"]').inputValue();
	const form = {
		projectKey: A,
		type: 'bug',
		priority: 'none',
		title: `Replay ${RUN}`,
		description: '',
		submissionId
	};
	const first = await ctx.request.post(`${baseURL}/issues/new`, {
		form,
		headers: ORIGIN,
		maxRedirects: 0
	});
	const second = await ctx.request.post(`${baseURL}/issues/new`, {
		form,
		headers: ORIGIN,
		maxRedirects: 0
	});
	expect(first.status(), (await first.text()).slice(0, 400)).toBe(303);
	expect(second.status()).toBe(303);
	expect(second.headers().location?.split('?')[0]).toBe(first.headers().location?.split('?')[0]);
	await ctx.close();
	expect(
		(await titlesOn(page, `/issues?project=${A}`)).filter((x) => x === `Replay ${RUN}`)
	).toHaveLength(1);

	// With JS: double click on submit.
	await page.goto(`/issues/new?project=${A}`);
	await page.getByLabel('Title').fill(`Dbl ${RUN}`);
	const btn = page.getByRole('button', { name: 'Report issue' });
	await btn.dblclick({ delay: 0 }).catch(() => {});
	await page.waitForURL(/\/tasks\/\d+/);
	expect(
		(await titlesOn(page, `/issues?project=${A}`)).filter((x) => x === `Dbl ${RUN}`)
	).toHaveLength(1);
});

test('team labels: admin-only, duplicates, cross-project filter, bulk', async ({ page }, info) => {
	desktopOnly(info);
	const name = `Care ${RUN}`;
	await page.goto('/admin/labels');
	await page.getByLabel('Name').first().fill(name);
	await page.getByLabel('Colour').first().selectOption('blue');
	await page.getByRole('button', { name: 'Add label' }).click();
	await expect(page.getByText(`Team label “${name}” added.`).first()).toBeVisible();
	await page.getByLabel('Name').first().fill(name.toUpperCase());
	await page.getByRole('button', { name: 'Add label' }).click();
	await expect(page.getByText(/already exists/i).first()).toBeVisible();
	const labelId = await page
		.locator('li.row', { hasText: name })
		.locator('input[name="id"]')
		.first()
		.inputValue();

	const ids = [
		...(await taskIds(page, `/issues?project=${A}&type=bug`)),
		...(await taskIds(page, `/issues?project=${B}&type=bug`))
	];
	expect(ids.length).toBeGreaterThanOrEqual(2);
	const res = await bulk(page, { taskId: ids, addTeamLabelId: labelId });
	expect(res, JSON.stringify(res)).toMatchObject({ type: 'success' });
	const t = await titlesOn(page, `/issues?project=${A}&project=${B}&label=${labelId}`);
	expect(t).toHaveLength(ids.length);
	await expect(page.locator('.wide tbody').getByText(name).first()).toBeVisible();
	// A label from another scope is dropped, not an error.
	const r = await page.goto(`/issues?label=00000000-0000-4000-8000-0000000000ff`);
	expect(r?.status()).toBe(200);
});

test('bulk: cap, all-or-nothing, archived project', async ({ page }, info) => {
	desktopOnly(info);
	const ids = await taskIds(page, `/issues?project=${A}`);
	const before = await titlesOn(page, `/issues?project=${A}&priority=urgent`);
	// 101 ids refused.
	const many = Array.from(
		{ length: 101 },
		(_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
	);
	const over = await bulk(page, { taskId: many, priority: 'urgent' });
	expect(over, JSON.stringify(over)).toMatchObject({ type: 'failure' });
	// One unknown id fails the whole request: nothing changes.
	const mixed = await bulk(page, {
		taskId: [...ids, '00000000-0000-4000-8000-0000000000aa'],
		priority: 'urgent'
	});
	expect(mixed, JSON.stringify(mixed)).toMatchObject({ type: 'failure' });
	expect(mixed.status).toBe(404);
	expect(await titlesOn(page, `/issues?project=${A}&priority=urgent`)).toEqual(before);

	// Archived project: tasks hidden by default, bulk refused (409) with nothing written.
	await makeProject(page, C);
	await report(page, C, `C-task ${RUN}`);
	const cIds = await taskIds(page, `/issues?project=${C}`);
	await page.goto(`/projects/${C}/settings`);
	await page.getByRole('button', { name: 'Archive', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Unarchive project' })).toBeVisible();
	expect(await titlesOn(page, `/issues?project=${C}`)).toHaveLength(0);
	expect(await titlesOn(page, `/issues?project=${C}&archived=1`)).toHaveLength(1);
	const arch = await bulk(page, { taskId: [...ids, ...cIds], priority: 'urgent' });
	expect(arch, JSON.stringify(arch)).toMatchObject({ type: 'failure', status: 409 });
	expect(await titlesOn(page, `/issues?project=${A}&priority=urgent`)).toEqual(before);
});

test('type shows in search and My tasks', async ({ page }, info) => {
	desktopOnly(info);
	const ids = await taskIds(page, `/issues?project=${A}&type=bug`);
	const res = await bulk(page, { taskId: ids, assigneeId: ADMIN_ID });
	expect(res, JSON.stringify(res)).toMatchObject({ type: 'success' });
	await page.goto('/my-tasks');
	await expect(page.getByText(`A-bug-urgent ${RUN}`).first()).toBeVisible();
	await expect(page.locator('main').getByText('Bug', { exact: true }).first()).toBeVisible();
	await page.goto(`/search?q=${encodeURIComponent(`A-bug-urgent ${RUN}`)}`);
	await expect(page.getByText(`A-bug-urgent`).first()).toBeVisible();
	await expect(page.locator('main').getByText('Bug', { exact: true }).first()).toBeVisible();
});

test('long title and many chips never widen the page on any phone', async ({ page }, info) => {
	const key = `QL${info.project.name
		.replace(/[^a-z0-9]/gi, '')
		.toUpperCase()
		.slice(0, 3)}${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
	await makeProject(page, key);
	const long = `Unbroken${'x'.repeat(150)} ${RUN}${info.project.name}`;
	await report(page, key, long, { type: 'bug' });
	for (const path of [
		`/issues?project=${key}`,
		'/issues/new',
		'/admin/labels',
		'/issues?archived=1'
	]) {
		await page.goto(path);
		await expectNoHorizontalOverflow(page);
	}
	if ((page.viewportSize()?.width ?? 1000) < 768) {
		await page.goto(`/issues?project=${key}`);
		await expect(page.locator('ul.narrow li.row').first()).toBeVisible();
		await expect(page.locator('.wide')).toBeHidden();
		await page.getByRole('button', { name: /^Filters/ }).tap();
		await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
		await expectNoHorizontalOverflow(page);
	}
});
