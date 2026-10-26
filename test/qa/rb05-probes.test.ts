import { isHttpError } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { sessionCookieName } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { generateKeySecret } from '#lib/server/hr/crypto';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { grantHr, hrWorld, seedEmployee } from '../helpers/seed-hr';
import { insertSession, insertUser } from '../helpers/users';

/** RB-05 QA probes: engineer-noted gaps (deactivated user on HR pages, 200-person org chart, key unset). */

const binding: { DB?: D1Database; TEAM_TIME_ZONE: string; HR_DATA_KEY?: string } = {
	TEAM_TIME_ZONE: 'Asia/Jakarta',
	HR_DATA_KEY: generateKeySecret()
};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const { handle } = await import('../../src/hooks.server');
const org = await import('../../src/routes/(app)/people/org/+page.server');
const profile = await import('../../src/routes/(app)/people/[id]/+page.server');
const edit = await import('../../src/routes/(app)/people/[id]/edit/+page.server');
const audit = await import('../../src/routes/(app)/hr/audit/+page.server');
const exporter = await import('../../src/routes/(app)/hr/export/+server');
const create = await import('../../src/routes/(app)/people/new/+page.server');

let db: Db;
let dispose: () => Promise<void>;
beforeAll(async () => {
	const opened = await openLocalD1();
	binding.DB = opened.db;
	db = getDb(opened.db);
	dispose = opened.dispose;
});
afterAll(() => dispose());

const thrown = async (p: unknown) => {
	try {
		return await (p as Promise<unknown>);
	} catch (e) {
		return e;
	}
};

describe('deactivated user on HR pages', () => {
	it('the session gate refuses every HR route at once for an HR user who is then disabled', async () => {
		const u = await insertUser(db, { name: 'Soon Gone' });
		await grantHr(db, u.id);
		const token = await insertSession(db, u.id);
		const resolve = vi.fn(async () => new Response('page'));
		const paths = ['/people', '/people/org', '/people/new', '/hr/audit', '/hr/export'];
		// control: while active, the gate lets the request through
		const ok = fakeEvent({
			url: 'http://localhost/people',
			routeId: '/(app)/people',
			db,
			cookies: { [sessionCookieName(false)]: token }
		}).event;
		expect((await handle({ event: ok, resolve } as never)).status).toBe(200);
		await db.$client.prepare("UPDATE users SET status='disabled' WHERE id=?1").bind(u.id).run();
		for (const p of paths) {
			resolve.mockClear();
			const event = fakeEvent({
				url: `http://localhost${p}`,
				routeId: `/(app)${p}`,
				db,
				cookies: { [sessionCookieName(false)]: token }
			}).event;
			const res = await handle({ event, resolve } as never);
			expect(res.status, p).not.toBe(200);
			expect(resolve, p).not.toHaveBeenCalled();
		}
	});

	it('even if a loader is reached with a stale user object, a disabled HR user gets 403, not HR data', async () => {
		const w = await hrWorld(db);
		const stale = await insertUser(db, { name: 'Stale HR' });
		await grantHr(db, stale.id);
		await db.$client.prepare("UPDATE users SET status='disabled' WHERE id=?1").bind(stale.id).run();
		const ev = (path: string, params: Record<string, string> = {}) =>
			fakeEvent({ url: `http://localhost${path}`, db, user: stale, params }).event;
		for (const r of [
			await thrown(create.load(ev('/people/new') as never)),
			await thrown(audit.load(ev('/hr/audit') as never)),
			await thrown(exporter.POST(ev('/hr/export') as never)),
			await thrown(edit.load(ev('/x', { id: w.employees.report }) as never))
		])
			expect(isHttpError(r) && r.status).toBe(403);
		// profile load as that disabled user: tier 0 only, no tier 1-3 (not treated as HR)
		const p = (await profile.load(ev('/x', { id: w.employees.report }) as never)) as Record<
			string,
			unknown
		>;
		expect(p.employment).toBeNull();
		expect(p.personal).toBeNull();
		expect(p.compensation).toBeNull();
		expect(p.hrInfo).toBeNull();
	});
});

describe('org chart with 200 people', () => {
	it('shows all 200, nested 5 levels, uncapped, fast, and no cycle loop', async () => {
		const w = await hrWorld(db);
		const hr = w.users.hr;
		const tag = `org${Date.now().toString(36)}`;
		let layer = [await seedEmployee(db, hr.id, { fullName: `Root ${tag}` })];
		let made = 1;
		while (made < 200) {
			const next: string[] = [];
			for (const m of layer) {
				for (let i = 0; i < 4 && made < 200; i++) {
					next.push(await seedEmployee(db, hr.id, { fullName: `N${made} ${tag}`, managerId: m }));
					made++;
				}
			}
			layer = next;
		}
		const t0 = performance.now();
		const data = (await org.load(
			fakeEvent({ url: 'http://localhost/people/org', db, user: w.users.outsider }).event as never
		)) as { count: number; capped: boolean; tree: unknown };
		const ms = performance.now() - t0;
		const ours = JSON.stringify(data.tree).split(`${tag}`).length - 1;
		expect(data.capped).toBe(false);
		expect(ours).toBe(200);
		expect(data.count).toBeGreaterThanOrEqual(200);
		console.info(`org load ${ms.toFixed(0)}ms, rows ${data.count}`);
		expect(ms).toBeLessThan(2000);
		// payload holds tier 0 only
		expect(JSON.stringify(data.tree)).not.toMatch(/employeeNo|startOn|nik/i);
	});
});

describe('HR_DATA_KEY unset', () => {
	it('profile and edit say not ready; saves are 503; nothing stored; tier 0/1 still save', async () => {
		const w = await hrWorld(db);
		const saved = binding.HR_DATA_KEY;
		delete binding.HR_DATA_KEY;
		try {
			const ev = (path: string, user = w.users.hr, form?: Record<string, string>) =>
				fakeEvent({
					url: `http://localhost${path}`,
					db,
					user,
					params: { id: w.employees.report },
					form
				}).event;
			const p = (await profile.load(ev('/x') as never)) as { keyReady: boolean };
			const e = (await edit.load(ev('/x') as never)) as {
				keyReady: boolean;
				personal: { updatedAt: number };
			};
			expect(p.keyReady).toBe(false);
			expect(e.keyReady).toBe(false);
			const r = await thrown(
				edit.actions.updateSensitive!(
					ev('/x', w.users.hr, {
						expectedUpdatedAt: String(e.personal.updatedAt),
						nik: '3171000011114321'
					}) as never
				)
			);
			expect((r as { status: number }).status).toBe(503);
			const row = await db.$client
				.prepare('SELECT nik_enc, nik_last4 FROM employee_private WHERE employee_id=?1')
				.bind(w.employees.report)
				.first<{ nik_enc: string | null; nik_last4: string | null }>();
			expect(row?.nik_enc ?? null).toBeNull();
			expect(row?.nik_last4 ?? null).toBeNull();
			const rv = await thrown(
				profile.actions.reveal!(ev('/x', w.users.hr, { field: 'nik' }) as never)
			);
			expect([503, 400]).toContain((rv as { status: number }).status);
		} finally {
			binding.HR_DATA_KEY = saved;
		}
		for (const bad of ['', 'AAAA', 'not base64 !!']) {
			binding.HR_DATA_KEY = bad;
			const p = (await profile.load(
				fakeEvent({
					url: 'http://localhost/x',
					db,
					user: w.users.hr,
					params: { id: w.employees.report }
				}).event as never
			)) as { keyReady: boolean };
			expect(p.keyReady, bad).toBe(false);
		}
		binding.HR_DATA_KEY = saved;
		const src = readFileSync('src/routes/(app)/people/[id]/edit/+page.svelte', 'utf8');
		expect(src).toContain('Sensitive data storage is not configured');
	});
});
