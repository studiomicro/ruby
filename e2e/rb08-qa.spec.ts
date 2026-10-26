import { expect, test } from '@playwright/test';

/** RB-08 QA probes: raw HTTP on the new routes (signed-out refusal, missing vs. forged ids, inert text). */
test('raw HTTP: signed-out refused on new routes and actions; missing milestone id = 404 signed in', async ({
	page,
	baseURL
}, info) => {
	test.skip(info.project.name !== 'desktop', 'raw HTTP: once');
	const f = (u: string, init: RequestInit = {}) =>
		fetch(new URL(u, baseURL!), { redirect: 'manual', ...init });
	const anon = {
		get: async (u: string) => f(u),
		post: async (u: string, o: { form: Record<string, string>; headers: Record<string, string> }) =>
			f(u, { method: 'POST', body: new URLSearchParams(o.form), headers: o.headers }),
		delete: async (u: string) => f(u, { method: 'DELETE', headers: { origin: baseURL! } })
	};
	const paths = [
		'/projects/ZZZ/milestones/00000000-0000-4000-8000-000000000000',
		'/projects/ZZZ/settings',
		'/projects/ZZZ',
		'/projects/ZZZ/tasks/1'
	];
	for (const p of paths) {
		const r = await anon.get(p);
		expect([302, 303, 401, 403], `GET ${p} -> ${r.status}`).toContain(r.status);
	}
	const actions: [string, string][] = [
		['/projects/ZZZ/settings', '?/labelSave'],
		['/projects/ZZZ/settings', '?/labelDelete'],
		['/projects/ZZZ/settings', '?/milestoneSave'],
		['/projects/ZZZ/settings', '?/columnsSave'],
		['/projects/ZZZ', '?/bulk'],
		['/projects/ZZZ', '?/viewSave'],
		['/projects/ZZZ/tasks/1', '?/checkAdd'],
		['/projects/ZZZ/tasks/1', '?/labelsSet']
	];
	for (const [p, a] of actions) {
		const r = await anon.post(p + a, {
			form: { name: 'x' },
			headers: { origin: baseURL! }
		});
		expect([302, 303, 401, 403], `POST ${p}${a} -> ${r.status}`).toContain(r.status);
	}
	const del = await anon.delete('/projects/ZZZ/views/00000000-0000-4000-8000-000000000000');
	expect([302, 303, 401, 403]).toContain(del.status);
	// signed in: unknown milestone and a syntactically bad id answer alike
	const a = await page.request.get(
		'/projects/NOPE/milestones/00000000-0000-4000-8000-000000000000'
	);
	const b = await page.request.get('/projects/NOPE/milestones/not-an-id');
	expect(a.status()).toBe(404);
	expect(b.status()).toBe(404);
});
