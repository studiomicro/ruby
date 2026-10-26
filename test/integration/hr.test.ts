import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { generateKeySecret } from '#lib/server/hr/crypto';
import { getEmployee, updateWork } from '#lib/server/hr/repo';
import { applyMigration, openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { auditRows, grantHr, hrWorld, seedEmployee } from '../helpers/seed-hr';
import { insertUser } from '../helpers/users';

/** RB-05 loads, actions and the export route called directly against local D1 (PRD acceptance criteria). */

const KEY = generateKeySecret();
const binding: { DB?: D1Database; TEAM_TIME_ZONE: string; HR_DATA_KEY?: string } = {
	TEAM_TIME_ZONE: 'Asia/Jakarta',
	HR_DATA_KEY: KEY
};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const directory = await import('../../src/routes/(app)/people/+page.server');
const org = await import('../../src/routes/(app)/people/org/+page.server');
const create = await import('../../src/routes/(app)/people/new/+page.server');
const profile = await import('../../src/routes/(app)/people/[id]/+page.server');
const edit = await import('../../src/routes/(app)/people/[id]/edit/+page.server');
const audit = await import('../../src/routes/(app)/hr/audit/+page.server');
const exporter = await import('../../src/routes/(app)/hr/export/+server');
const adminUsers = await import('../../src/routes/(app)/admin/users/+page.server');

let db: Db;
let raw: D1Database;
let dispose: () => Promise<void>;
beforeAll(async () => {
	const opened = await openLocalD1();
	binding.DB = opened.db;
	raw = opened.db;
	db = getDb(opened.db);
	dispose = opened.dispose;
});
afterAll(() => dispose());

type Fn = (event: never) => unknown;
async function run(fn: unknown, event: unknown): Promise<unknown> {
	try {
		return await (fn as Fn)(event as never);
	} catch (e) {
		return e;
	}
}
const status = (r: unknown) =>
	isHttpError(r)
		? r.status
		: isRedirect(r)
			? r.status
			: ((r as { status?: number })?.status ?? 200);
const dataOf = (r: unknown) => (r as { data: Record<string, unknown> }).data;

function req(
	user: SessionUser | null,
	path: string,
	options: { form?: Record<string, string>; params?: Record<string, string>; method?: string } = {}
) {
	return fakeEvent({
		url: `http://localhost${path}`,
		db,
		user,
		form: options.form,
		params: options.params,
		method: options.method
	}).event;
}

const viewProfile = (user: SessionUser | null, id: string) =>
	run(profile.load, req(user, `/people/${id}`, { params: { id } }));
const act = (
	fn: unknown,
	user: SessionUser | null,
	id: string,
	form: Record<string, string>,
	path = `/people/${id}`
) => run(fn, req(user, path, { params: { id }, form }));
const reveal = (user: SessionUser, id: string, field: string, ref = '') =>
	act(profile.actions.reveal, user, id, { field, ref });

async function setSensitive(hr: SessionUser, id: string, fields: Record<string, string>) {
	const loaded = (await run(edit.load, req(hr, `/people/${id}/edit`, { params: { id } }))) as {
		personal: { updatedAt: number };
	};
	return act(
		edit.actions.updateSensitive,
		hr,
		id,
		{ expectedUpdatedAt: String(loaded.personal.updatedAt), ...fields },
		`/people/${id}/edit`
	);
}

const NIK = '3171098765432101';

describe('access matrix (AC1-AC3, AC7)', () => {
	it('signed-out requests are refused everywhere', async () => {
		const w = await hrWorld(db);
		const id = w.employees.report;
		for (const [fn, path] of [
			[directory.load, '/people'],
			[org.load, '/people/org'],
			[create.load, '/people/new'],
			[profile.load, `/people/${id}`],
			[edit.load, `/people/${id}/edit`],
			[audit.load, '/hr/audit']
		] as const)
			expect(status(await run(fn, req(null, path, { params: { id } })))).toBe(401);
		expect(status(await act(profile.actions.reveal, null, id, { field: 'nik' }))).toBe(401);
		expect(status(await act(edit.actions.updateWork, null, id, { fullName: 'x' }))).toBe(401);
		expect(status(await run(exporter.POST, req(null, '/hr/export', { method: 'POST' })))).toBe(401);
	});

	it('a member sees tier 0 only; nothing of tier 1 or 2 is in the payload', async () => {
		const w = await hrWorld(db);
		await setSensitive(w.users.hr, w.employees.report, { nik: NIK, home_address: 'Jl. Rahasia 9' });
		const page = (await viewProfile(w.users.outsider, w.employees.report)) as Record<
			string,
			unknown
		>;
		expect(page.employment).toBeNull();
		expect(page.personal).toBeNull();
		expect(page.contacts).toBeNull();
		expect(page.compensation).toBeNull();
		expect(page.hrInfo).toBeNull();
		const text = JSON.stringify(page);
		for (const secret of [`EMP-${w.tag}`, '2024-03-04', NIK, NIK.slice(-4), 'Rahasia', 'v1.'])
			expect(text).not.toContain(secret);
		expect(text).toContain('Fictional analyst');
	});

	it('the direct manager sees tier 1 but no tier 2; skip-level sees tier 0 only', async () => {
		const w = await hrWorld(db);
		const asManager = (await viewProfile(w.users.managerUser, w.employees.report)) as Record<
			string,
			{ employeeNo?: string } | null
		>;
		expect(asManager.employment?.employeeNo).toBe(`EMP-${w.tag}`);
		expect(asManager.personal).toBeNull();
		const asTop = (await viewProfile(w.users.topUser, w.employees.report)) as Record<
			string,
			unknown
		>;
		expect(asTop.employment).toBeNull();
		expect(status(await reveal(w.users.managerUser, w.employees.report, 'nik'))).toBe(404);
	});

	it('an admin who is not HR: 403 on HR pages, can read the audit log', async () => {
		const w = await hrWorld(db);
		const a = w.users.admin;
		const id = w.employees.report;
		expect(status(await run(create.load, req(a, '/people/new')))).toBe(403);
		expect(status(await run(edit.load, req(a, `/people/${id}/edit`, { params: { id } })))).toBe(
			403
		);
		expect(status(await act(edit.actions.updateWork, a, id, { fullName: 'x' }))).toBe(403);
		expect(status(await run(exporter.POST, req(a, '/hr/export', { method: 'POST' })))).toBe(403);
		expect(status(await reveal(a, id, 'nik'))).toBe(404);
		expect(status(await run(audit.load, req(a, '/hr/audit')))).toBe(200);
		expect(status(await run(audit.load, req(w.users.outsider, '/hr/audit')))).toBe(403);
	});

	it('hidden and missing ids answer the same 404', async () => {
		const w = await hrWorld(db);
		const missing = crypto.randomUUID();
		expect(status(await viewProfile(w.users.outsider, missing))).toBe(404);
		expect(status(await viewProfile(w.users.outsider, 'not-a-uuid'))).toBe(404);
		await act(
			edit.actions.terminate,
			w.users.hr,
			w.employees.contractor,
			{
				expectedUpdatedAt: String((await getEmployee(db, w.employees.contractor))!.updatedAt),
				endOn: '2026-10-01',
				confirm: 'on'
			},
			`/people/${w.employees.contractor}/edit`
		);
		const hidden = await viewProfile(w.users.outsider, w.employees.contractor);
		const gone = await viewProfile(w.users.outsider, missing);
		expect(status(hidden)).toBe(404);
		expect((hidden as Error).message).toBe((gone as Error).message);
	});
});

describe('reveal (AC4, AC8-AC11, AC21)', () => {
	it('stores only ciphertext and last four; HR reveal writes one audit row first', async () => {
		const w = await hrWorld(db);
		const id = w.employees.report;
		expect(
			status(await setSensitive(w.users.hr, id, { nik: NIK, bank_account: '0012345678' }))
		).toBe(200);
		const row = await raw
			.prepare('SELECT * FROM employee_private WHERE employee_id = ?1')
			.bind(id)
			.first<Record<string, unknown>>();
		expect(String(row?.nik_enc)).toMatch(/^v1\./);
		expect(row?.nik_last4).toBe('2101');
		expect(JSON.stringify(row)).not.toContain(NIK);
		const auditText = JSON.stringify(await auditRows(db, { employeeId: id }));
		expect(auditText).not.toContain(NIK);
		expect(auditText).toContain('sensitive_update');

		const before = (await auditRows(db, { actorId: w.users.hr.id })).length;
		const result = await reveal(w.users.hr, id, 'nik');
		expect(dataOf({ data: result }).revealed).toEqual({ field: 'nik', ref: '', value: NIK });
		const after = await auditRows(db, { actorId: w.users.hr.id });
		expect(after).toHaveLength(before + 1);
		expect(after.at(-1)).toMatchObject({
			action: 'sensitive_view',
			fields: '["nik"]',
			employeeId: id
		});
	});

	it('the employee reveals their own value (audited too); masked in the page', async () => {
		const w = await hrWorld(db);
		const id = w.employees.report;
		await setSensitive(w.users.hr, id, { nik: NIK });
		const page = (await viewProfile(w.users.reportUser, id)) as {
			personal: { fields: { field: string; masked: string; set: boolean }[] };
		};
		expect(page.personal.fields.find((f) => f.field === 'nik')).toMatchObject({
			set: true,
			masked: '•••• 2101'
		});
		expect(JSON.stringify(page)).not.toContain(NIK);
		const result = (await reveal(w.users.reportUser, id, 'nik')) as { revealed: { value: string } };
		expect(result.revealed.value).toBe(NIK);
		expect((await auditRows(db, { actorId: w.users.reportUser.id })).at(-1)?.action).toBe(
			'sensitive_view'
		);
	});

	it('a failing audit insert refuses the reveal and returns no value', async () => {
		const w = await hrWorld(db);
		const id = w.employees.report;
		await setSensitive(w.users.hr, id, { nik: NIK });
		await raw
			.prepare(
				`CREATE TRIGGER test_audit_fail BEFORE INSERT ON hr_audit_log WHEN NEW.actor_id = '${w.users.hr.id}'
				 BEGIN SELECT RAISE(ABORT, 'injected'); END`
			)
			.run();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const result = await reveal(w.users.hr, id, 'nik');
			expect(status(result)).toBe(503);
			expect(JSON.stringify(result)).not.toContain(NIK);
			expect(JSON.stringify(log.mock.calls)).not.toContain(NIK);
		} finally {
			log.mockRestore();
			await raw.prepare('DROP TRIGGER test_audit_fail').run();
		}
	});

	it('others get 404 and no audit row; unknown fields 400; nothing stored 400', async () => {
		const w = await hrWorld(db);
		const id = w.employees.report;
		await setSensitive(w.users.hr, id, { nik: NIK });
		for (const u of [w.users.managerUser, w.users.admin, w.users.outsider]) {
			expect(status(await reveal(u, id, 'nik'))).toBe(404);
			expect(await auditRows(db, { actorId: u.id })).toHaveLength(0);
		}
		expect(status(await reveal(w.users.hr, id, 'full_name'))).toBe(400);
		expect(status(await reveal(w.users.hr, id, 'npwp'))).toBe(400);
		expect(
			status(await reveal(w.users.reportUser, id, 'compensation_amount', crypto.randomUUID()))
		).toBe(404);
	});

	it('without HR_DATA_KEY (or with a malformed one) tier 2 is read-only and nothing is stored', async () => {
		const w = await hrWorld(db);
		const id = w.employees.report;
		await setSensitive(w.users.hr, id, { nik: NIK });
		for (const bad of [undefined, 'short', btoa('x'.repeat(31))]) {
			binding.HR_DATA_KEY = bad;
			try {
				const page = (await viewProfile(w.users.hr, id)) as { keyReady: boolean };
				expect(page.keyReady).toBe(false);
				expect(status(await setSensitive(w.users.hr, id, { npwp: '1'.repeat(15) }))).toBe(503);
				expect(status(await reveal(w.users.hr, id, 'nik'))).toBe(503);
				expect(
					status(
						await act(profile.actions.addContact, w.users.reportUser, id, {
							contactName: 'Fictional Kin',
							relationship: 'Sibling',
							contactPhone: '0811 000 111'
						})
					)
				).toBe(503);
				// Tier 0 and 1 still work.
				expect(status(await run(directory.load, req(w.users.hr, '/people')))).toBe(200);
			} finally {
				binding.HR_DATA_KEY = KEY;
			}
		}
		const row = await raw
			.prepare('SELECT npwp_enc FROM employee_private WHERE employee_id = ?1')
			.bind(id)
			.first<{ npwp_enc: string | null }>();
		expect(row?.npwp_enc).toBeNull();
	});

	it('a ciphertext moved to another employee or field no longer decrypts', async () => {
		const w = await hrWorld(db);
		await setSensitive(w.users.hr, w.employees.report, { nik: NIK });
		await setSensitive(w.users.hr, w.employees.manager, { npwp: '1'.repeat(16) });
		await raw
			.prepare(
				`UPDATE employee_private SET nik_enc = (SELECT nik_enc FROM employee_private WHERE employee_id = ?1),
					npwp_enc = (SELECT nik_enc FROM employee_private WHERE employee_id = ?1) WHERE employee_id = ?2`
			)
			.bind(w.employees.report, w.employees.manager)
			.run();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(status(await reveal(w.users.hr, w.employees.manager, 'nik'))).toBe(500);
			expect(status(await reveal(w.users.hr, w.employees.manager, 'npwp'))).toBe(500);
		} finally {
			log.mockRestore();
		}
	});

	it('the 31st reveal in 10 minutes is refused with 429 and no audit row', async () => {
		const w = await hrWorld(db);
		const id = w.employees.report;
		await setSensitive(w.users.hr, id, { nik: NIK });
		for (let i = 0; i < 30; i++) expect(status(await reveal(w.users.hr, id, 'nik'))).toBe(200);
		const before = (await auditRows(db, { actorId: w.users.hr.id })).length;
		expect(status(await reveal(w.users.hr, id, 'nik'))).toBe(429);
		expect(await auditRows(db, { actorId: w.users.hr.id })).toHaveLength(before);
	});
});

describe('self-service (AC4, AC5) and emergency contacts', () => {
	it('own preferred name and work phone change; other posted fields are ignored', async () => {
		const w = await hrWorld(db);
		const id = w.employees.report;
		const e = (await getEmployee(db, id))!;
		const result = await act(profile.actions.updateSelf, w.users.reportUser, id, {
			expectedUpdatedAt: String(e.updatedAt),
			preferredName: 'Rep',
			workPhone: '+62 21 555 0101',
			fullName: 'Hijacked',
			managerId: w.employees.contractor,
			employeeNo: 'X1',
			userId: w.users.outsider.id,
			isHr: '1'
		});
		expect(status(result)).toBe(200);
		const after = (await getEmployee(db, id))!;
		expect(after).toMatchObject({
			preferredName: 'Rep',
			workPhone: '+62 21 555 0101',
			fullName: e.fullName,
			managerId: e.managerId,
			employeeNo: e.employeeNo,
			userId: w.users.reportUser.id
		});
		expect((await auditRows(db, { actorId: w.users.reportUser.id })).at(-1)).toMatchObject({
			action: 'employee_update',
			fields: '["preferred_name","work_phone"]'
		});
		// Sensitive fields beyond phone and address are ignored on the self form.
		const personal = await act(profile.actions.updateSelfPersonal, w.users.reportUser, id, {
			expectedUpdatedAt: '0',
			personal_phone: '0812 1111 2222',
			nik: NIK
		});
		expect(status(personal)).toBe(200);
		const row = await raw
			.prepare('SELECT nik_enc, personal_phone_enc FROM employee_private WHERE employee_id = ?1')
			.bind(id)
			.first<{ nik_enc: string | null; personal_phone_enc: string | null }>();
		expect(row?.nik_enc).toBeNull();
		expect(row?.personal_phone_enc).toMatch(/^v1\./);
		// Someone else cannot use the self actions.
		expect(
			status(
				await act(profile.actions.updateSelf, w.users.managerUser, id, {
					expectedUpdatedAt: String(after.updatedAt),
					preferredName: 'x'
				})
			)
		).toBe(404);
	});

	it('at most three emergency contacts; names and phones encrypted and revealable', async () => {
		const w = await hrWorld(db);
		const id = w.employees.report;
		const add = (n: number) =>
			act(profile.actions.addContact, w.users.reportUser, id, {
				contactName: `Fictional Kin ${n}`,
				relationship: 'Sibling',
				contactPhone: `0811 000 ${100 + n}`
			});
		for (const n of [1, 2, 3]) expect(status(await add(n))).toBe(200);
		expect(status(await add(4))).toBe(400);
		const { results } = await raw
			.prepare('SELECT id, name_enc FROM employee_emergency_contacts WHERE employee_id = ?1')
			.bind(id)
			.all<{ id: string; name_enc: string }>();
		expect(results).toHaveLength(3);
		expect(JSON.stringify(results)).not.toContain('Fictional Kin');
		const value = (await reveal(w.users.reportUser, id, 'contact_name', results[0]!.id)) as {
			revealed: { value: string };
		};
		expect(value.revealed.value).toMatch(/^Fictional Kin \d$/);
		// A contact id of another employee does not reveal anything.
		expect(
			status(await reveal(w.users.hr, w.employees.manager, 'contact_name', results[0]!.id))
		).toBe(400);
		expect(
			status(
				await act(profile.actions.removeContact, w.users.reportUser, id, {
					contactId: results[0]!.id
				})
			)
		).toBe(200);
		expect(status(await add(5))).toBe(200);
	});
});

describe('HR writes (AC6, AC13-AC16)', () => {
	it('HR creates an employee; the audit row names fields only', async () => {
		const w = await hrWorld(db);
		const result = await act(
			create.actions.default,
			w.users.hr,
			'',
			{
				fullName: `New Hire ${w.tag}`,
				employmentType: 'intern',
				employeeNo: `NEW-${w.tag}`,
				managerId: w.employees.manager
			},
			'/people/new'
		);
		expect(status(result)).toBe(303);
		const id = (result as { location: string }).location.split('/')[2]!.split('?')[0]!;
		expect((await getEmployee(db, id))?.employmentType).toBe('intern');
		const [row] = await auditRows(db, { employeeId: id });
		expect(row?.action).toBe('employee_create');
		expect(row?.fields).not.toContain('New Hire');
		// Duplicate employee number among live rows.
		const dup = await act(
			create.actions.default,
			w.users.hr,
			'',
			{
				fullName: 'Another',
				employmentType: 'permanent',
				employeeNo: `NEW-${w.tag}`
			},
			'/people/new'
		);
		expect(status(dup)).toBe(400);
		expect(dataOf(dup).errors).toEqual({ employeeNo: 'That employee number is already used.' });
	});

	it('a stale expectedUpdatedAt answers 409 and changes nothing', async () => {
		const w = await hrWorld(db);
		const id = w.employees.contractor;
		const e = (await getEmployee(db, id))!;
		const result = await act(
			edit.actions.updateWork,
			w.users.hr,
			id,
			{
				expectedUpdatedAt: String(e.updatedAt - 1),
				fullName: 'Changed',
				employmentType: 'contract'
			},
			`/people/${id}/edit`
		);
		expect(status(result)).toBe(409);
		expect((await getEmployee(db, id))?.fullName).toBe(e.fullName);
	});

	it('a forced audit failure rolls the update back', async () => {
		const w = await hrWorld(db);
		const id = w.employees.contractor;
		const e = (await getEmployee(db, id))!;
		await raw
			.prepare(
				`CREATE TRIGGER test_audit_fail2 BEFORE INSERT ON hr_audit_log WHEN NEW.actor_id = '${w.users.hr.id}'
				 BEGIN SELECT RAISE(ABORT, 'injected'); END`
			)
			.run();
		try {
			await expect(
				updateWork(db, w.users.hr.id, e, { fullName: 'Rolled back' }, e.updatedAt, Date.now())
			).rejects.toThrow();
		} finally {
			await raw.prepare('DROP TRIGGER test_audit_fail2').run();
		}
		expect((await getEmployee(db, id))?.fullName).toBe(e.fullName);
	});

	it('manager: not self, not a descendant, not terminated; a concurrent cycle cannot form', async () => {
		const w = await hrWorld(db);
		const { top, manager, report } = w.employees;
		const tryManager = async (id: string, managerId: string) => {
			const e = (await getEmployee(db, id))!;
			return updateWork(db, w.users.hr.id, e, { managerId }, e.updatedAt, Date.now());
		};
		expect(await tryManager(manager, manager)).toMatchObject({ ok: false, reason: 'invalid' });
		expect(await tryManager(top, report)).toMatchObject({ ok: false, reason: 'invalid' });
		// Two unrelated roots pointing at each other at the same time: at most one succeeds.
		const a = await seedEmployee(db, w.users.hr.id);
		const b = await seedEmployee(db, w.users.hr.id);
		const [ea, eb] = [(await getEmployee(db, a))!, (await getEmployee(db, b))!];
		const results = await Promise.all([
			updateWork(db, w.users.hr.id, ea, { managerId: b }, ea.updatedAt, Date.now()),
			updateWork(db, w.users.hr.id, eb, { managerId: a }, eb.updatedAt, Date.now())
		]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		const after = [(await getEmployee(db, a))!, (await getEmployee(db, b))!];
		expect(after.filter((e) => e.managerId !== null)).toHaveLength(1);
	});

	it('one account links to one live employee, also under 20 concurrent links', async () => {
		const w = await hrWorld(db);
		const free = await insertUser(db);
		const ids = await Promise.all(
			Array.from({ length: 20 }, () => seedEmployee(db, w.users.hr.id))
		);
		const results = await Promise.all(
			ids.map(async (id) => {
				const e = (await getEmployee(db, id))!;
				return act(
					edit.actions.linkUser,
					w.users.hr,
					id,
					{
						expectedUpdatedAt: String(e.updatedAt),
						userId: free.id
					},
					`/people/${id}/edit`
				);
			})
		);
		expect(results.filter((r) => status(r) === 200)).toHaveLength(1);
		const linked = await raw
			.prepare('SELECT count(*) AS n FROM employees WHERE user_id = ?1 AND deleted_at IS NULL')
			.bind(free.id)
			.first<{ n: number }>();
		expect(linked?.n).toBe(1);
	});

	it('terminate is idempotent, hides from non-HR; reinstate clears; delete frees the number', async () => {
		const w = await hrWorld(db);
		const id = w.employees.report;
		const fresh = async () => (await getEmployee(db, id))!;
		const term = async () =>
			act(
				edit.actions.terminate,
				w.users.hr,
				id,
				{
					expectedUpdatedAt: String((await fresh()).updatedAt),
					endOn: '2026-10-20',
					confirm: 'on'
				},
				`/people/${id}/edit`
			);
		expect(status(await term())).toBe(200);
		expect(status(await term())).toBe(200);
		expect(await fresh()).toMatchObject({ status: 'terminated', endOn: '2026-10-20' });
		expect(
			(await auditRows(db, { employeeId: id })).filter((r) => r.action === 'employee_terminate')
		).toHaveLength(1);
		expect(status(await viewProfile(w.users.reportUser, id))).toBe(404);
		expect(status(await viewProfile(w.users.hr, id))).toBe(200);
		const listed = (await run(
			directory.load,
			req(w.users.outsider, `/people?department=${encodeURIComponent(w.department)}`)
		)) as { rows: { id: string }[] };
		expect(listed.rows.map((r) => r.id)).not.toContain(id);
		const terminatedList = (await run(
			directory.load,
			req(w.users.hr, `/people?status=terminated&department=${encodeURIComponent(w.department)}`)
		)) as { rows: { id: string }[] };
		expect(terminatedList.rows.map((r) => r.id)).toEqual([id]);
		expect(
			(await auditRows(db, { actorId: w.users.hr.id })).some((r) => r.action === 'list_terminated')
		).toBe(true);
		expect(
			status(
				await act(
					edit.actions.reinstate,
					w.users.hr,
					id,
					{ expectedUpdatedAt: String((await fresh()).updatedAt) },
					`/people/${id}/edit`
				)
			)
		).toBe(200);
		expect(await fresh()).toMatchObject({ status: 'active', endOn: null });

		// Delete frees the employee number; restoring after reuse fails cleanly.
		const del = await act(
			edit.actions.delete,
			w.users.hr,
			id,
			{ expectedUpdatedAt: String((await fresh()).updatedAt), confirm: 'on' },
			`/people/${id}/edit`
		);
		expect(status(del)).toBe(303);
		await seedEmployee(db, w.users.hr.id, { employeeNo: `EMP-${w.tag}` });
		const res = await act(
			edit.actions.restore,
			w.users.hr,
			id,
			{ expectedUpdatedAt: String((await fresh()).updatedAt) },
			`/people/${id}/edit`
		);
		expect(status(res)).toBe(400);
		expect((await fresh()).deletedAt).not.toBeNull();
	});

	it('salary records: HR only, encrypted, append-only, revealed with an audit row', async () => {
		const w = await hrWorld(db);
		const id = w.employees.report;
		expect(
			status(
				await act(
					edit.actions.addCompensation,
					w.users.hr,
					id,
					{ effectiveOn: '2026-01-01', amount: '12.500.000', note: 'Fictional raise' },
					`/people/${id}/edit`
				)
			)
		).toBe(200);
		const self = (await viewProfile(w.users.reportUser, id)) as { compensation: unknown };
		expect(self.compensation).toBeNull();
		const hrView = (await viewProfile(w.users.hr, id)) as {
			compensation: { id: string; hasNote: boolean }[];
		};
		expect(hrView.compensation).toHaveLength(1);
		const entry = hrView.compensation[0]!;
		const stored = await raw
			.prepare('SELECT * FROM employee_compensation WHERE id = ?1')
			.bind(entry.id)
			.first<Record<string, unknown>>();
		expect(JSON.stringify(stored)).not.toMatch(/12500000|1250000000|Fictional raise/);
		expect(status(await reveal(w.users.reportUser, id, 'compensation_amount', entry.id))).toBe(404);
		const value = (await reveal(w.users.hr, id, 'compensation_amount', entry.id)) as {
			revealed: { value: string };
		};
		expect(value.revealed.value).toBe('Rp 12.500.000');
		expect((await auditRows(db, { actorId: w.users.hr.id })).at(-1)?.action).toBe(
			'compensation_view'
		);
		await expect(
			raw
				.prepare('UPDATE employee_compensation SET currency = currency WHERE id = ?1')
				.bind(entry.id)
				.run()
		).rejects.toThrow(/append-only/);
		await expect(
			raw.prepare('DELETE FROM employee_compensation WHERE id = ?1').bind(entry.id).run()
		).rejects.toThrow(/append-only/);
	});
});

describe('directory, org chart, audit log, export (AC16-AC20)', () => {
	it('search matches %, _ and \\ literally; 51 characters answer 400; 50 per page', async () => {
		const w = await hrWorld(db);
		await seedEmployee(db, w.users.hr.id, {
			fullName: `Literal 100%_\\ ${w.tag}`,
			department: w.department
		});
		await seedEmployee(db, w.users.hr.id, {
			fullName: `Literal 100ab ${w.tag}`,
			department: w.department
		});
		const found = (await run(
			directory.load,
			req(w.users.outsider, `/people?q=${encodeURIComponent('100%_\\')}`)
		)) as { rows: { fullName: string }[] };
		expect(found.rows.map((r) => r.fullName)).toEqual([`Literal 100%_\\ ${w.tag}`]);
		expect(
			status(await run(directory.load, req(w.users.outsider, `/people?q=${'x'.repeat(51)}`)))
		).toBe(400);
		expect(
			status(await run(directory.load, req(w.users.outsider, `/people?q=${'é'.repeat(50)}`)))
		).toBe(200);
		const dept = `Big ${w.tag}`;
		for (let i = 0; i < 55; i++) await seedEmployee(db, w.users.hr.id, { department: dept });
		const p1 = (await run(
			directory.load,
			req(w.users.outsider, `/people?department=${encodeURIComponent(dept)}`)
		)) as { rows: unknown[]; total: number };
		const p2 = (await run(
			directory.load,
			req(w.users.outsider, `/people?department=${encodeURIComponent(dept)}&page=2`)
		)) as { rows: unknown[] };
		expect([p1.rows.length, p2.rows.length, p1.total]).toEqual([50, 5, 55]);
	});

	it('the org chart nests the chain and shows a terminated manager’s report as a root', async () => {
		const w = await hrWorld(db);
		type N = { id: string; children: N[] };
		const find = (nodes: N[], id: string): N | undefined => {
			for (const n of nodes) {
				if (n.id === id) return n;
				const hit = find(n.children, id);
				if (hit) return hit;
			}
		};
		const chart = (await run(org.load, req(w.users.outsider, '/people/org'))) as { tree: N[] };
		const top = chart.tree.find((n) => n.id === w.employees.top)!;
		expect(top.children[0]!.id).toBe(w.employees.manager);
		expect(top.children[0]!.children.map((c) => c.id).sort()).toEqual(
			[w.employees.report, w.employees.contractor].sort()
		);
		const m = (await getEmployee(db, w.employees.manager))!;
		await act(
			edit.actions.terminate,
			w.users.hr,
			m.id,
			{ expectedUpdatedAt: String(m.updatedAt), endOn: '2026-10-25', confirm: 'on' },
			`/people/${m.id}/edit`
		);
		const after = (await run(org.load, req(w.users.outsider, '/people/org'))) as { tree: N[] };
		expect(after.tree.map((n) => n.id)).toContain(w.employees.report);
		expect(find(after.tree, w.employees.manager)).toBeUndefined();
	});

	it('the audit log cannot be updated or deleted; pages without duplicates', async () => {
		const w = await hrWorld(db);
		await expect(raw.prepare("UPDATE hr_audit_log SET detail = 'x'").run()).rejects.toThrow(
			/append-only/
		);
		await expect(raw.prepare('DELETE FROM hr_audit_log').run()).rejects.toThrow(/append-only/);
		const at = Date.now();
		for (let i = 0; i < 60; i++)
			await raw
				.prepare(
					`INSERT INTO hr_audit_log (id, at, actor_id, action, fields, detail) VALUES (?1, ?2, ?3, 'export', '[]', '')`
				)
				.bind(crypto.randomUUID(), at, w.users.outsider.id)
				.run();
		const seen = new Set<string>();
		let path = `/hr/audit?actor=${w.users.outsider.id}`;
		for (;;) {
			const page = (await run(audit.load, req(w.users.hr, path))) as {
				rows: { id: string }[];
				next: string | null;
			};
			for (const r of page.rows) seen.add(r.id);
			if (!page.next) break;
			path = `/hr/audit?actor=${w.users.outsider.id}&before=${page.next}`;
		}
		expect(seen.size).toBe(60);
	});

	it('export: HR only, tier 0 and 1, neutralised, audited, 6th in 10 minutes is 429', async () => {
		const w = await hrWorld(db);
		await seedEmployee(db, w.users.hr.id, { fullName: '=cmd|calc', department: w.department });
		await setSensitive(w.users.hr, w.employees.report, { nik: NIK });
		const post = () => run(exporter.POST, req(w.users.hr, '/hr/export', { method: 'POST' }));
		const response = (await post()) as Response;
		expect(response.headers.get('content-type')).toContain('text/csv');
		const csv = await response.text();
		expect(csv).toContain(`"'=cmd|calc"`);
		expect(csv).toContain(`EMP-${w.tag}`);
		expect(csv).not.toContain(NIK);
		expect(csv).not.toMatch(/NIK|v1\./);
		const row = (await auditRows(db, { actorId: w.users.hr.id })).filter(
			(r) => r.action === 'export'
		);
		expect(row).toHaveLength(1);
		expect(row[0]!.detail).toMatch(/^\d+ rows$/);
		for (let i = 0; i < 4; i++) expect(status(await post())).toBe(200);
		expect(status(await post())).toBe(429);
	});
});

describe('HR flag (AC22) and migration', () => {
	it('only an admin grants, only to an active account; audited; revoke bites on the next request', async () => {
		const w = await hrWorld(db);
		const target = await insertUser(db);
		const setHr = (actor: SessionUser, userId: string, isHr: string) =>
			run(adminUsers.actions.setHr, req(actor, '/admin/users', { form: { userId, isHr } }));
		expect(status(await setHr(w.users.outsider, target.id, '1'))).toBe(403);
		expect(status(await setHr(w.users.hr, target.id, '1'))).toBe(403);
		expect(status(await setHr(w.users.admin, w.users.disabled.id, '1'))).toBe(400);
		expect(status(await setHr(w.users.admin, target.id, '1'))).toBe(200);
		expect(status(await setHr(w.users.admin, target.id, '1'))).toBe(200);
		expect(status(await run(create.load, req(target, '/people/new')))).toBe(200);
		expect(status(await setHr(w.users.admin, target.id, '0'))).toBe(200);
		expect(status(await run(create.load, req(target, '/people/new')))).toBe(403);
		const rows = (await auditRows(db, { actorId: w.users.admin.id })).filter(
			(r) => r.userId === target.id
		);
		expect(rows.map((r) => r.action)).toEqual(['hr_grant', 'hr_revoke']);
		// The owner, the only admin, may grant themselves (owner answer 2026-10-26), audited.
		expect(status(await setHr(w.users.admin, w.users.admin.id, '1'))).toBe(200);
		expect((await auditRows(db, { actorId: w.users.admin.id })).at(-1)).toMatchObject({
			action: 'hr_grant',
			userId: w.users.admin.id
		});
		await grantHr(db, w.users.admin.id);
	});

	it('0002 applies to a database with existing users without data loss', async () => {
		const opened = await openLocalD1({ before: '0002' });
		try {
			await opened.db
				.prepare(
					`INSERT INTO users (id, email, name, role, status, created_at) VALUES ('u1', 'a@example.test', 'A', 'admin', 'active', 1)`
				)
				.run();
			await applyMigration(opened.db, '0002_hr_core.sql');
			const row = await opened.db
				.prepare('SELECT name, is_hr FROM users WHERE id = ?1')
				.bind('u1')
				.first();
			expect(row).toEqual({ name: 'A', is_hr: 0 });
			await expect(opened.db.prepare('UPDATE users SET is_hr = 2').run()).rejects.toThrow();
		} finally {
			await opened.dispose();
		}
	});

	it('disabling an account clears its HR flag with an audit row; re-enabling does not restore it', async () => {
		const w = await hrWorld(db);
		const target = await insertUser(db);
		await grantHr(db, target.id);
		const setStatus = (status: string) =>
			run(
				adminUsers.actions.setStatus,
				req(w.users.admin, '/admin/users', { form: { userId: target.id, status } })
			);
		expect(status(await setStatus('disabled'))).toBe(200);
		const isHr = async () =>
			(
				await raw
					.prepare('SELECT is_hr FROM users WHERE id = ?1')
					.bind(target.id)
					.first<{ is_hr: number }>()
			)?.is_hr;
		expect(await isHr()).toBe(0);
		const rows = (await auditRows(db, { actorId: w.users.admin.id })).filter(
			(r) => r.userId === target.id
		);
		expect(rows).toEqual([
			expect.objectContaining({
				action: 'hr_revoke',
				fields: '["is_hr"]',
				detail: 'account disabled'
			})
		]);
		expect(status(await setStatus('active'))).toBe(200);
		expect(await isHr()).toBe(0);
		// Disabling an account that is not HR writes no HR audit row.
		const plain = await insertUser(db);
		await run(
			adminUsers.actions.setStatus,
			req(w.users.admin, '/admin/users', { form: { userId: plain.id, status: 'disabled' } })
		);
		expect(
			(await auditRows(db, { actorId: w.users.admin.id })).filter((r) => r.userId === plain.id)
		).toEqual([]);
	});

	it('a value written under an unknown key_version is refused, not decrypted', async () => {
		const w = await hrWorld(db);
		const id = w.employees.report;
		await setSensitive(w.users.hr, id, { nik: NIK });
		expect(status(await reveal(w.users.hr, id, 'nik'))).toBe(200);
		await raw
			.prepare('UPDATE employee_private SET key_version = 2 WHERE employee_id = ?1')
			.bind(id)
			.run();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const refused = await reveal(w.users.hr, id, 'nik');
			expect(status(refused)).toBe(500);
			expect(JSON.stringify(refused)).not.toContain(NIK);
		} finally {
			log.mockRestore();
		}
	});

	it('the cycle guard walks deleted rows, and restore refuses to close a loop', async () => {
		const w = await hrWorld(db);
		const hr = w.users.hr.id;
		const a = await seedEmployee(db, hr);
		const b = await seedEmployee(db, hr, { managerId: a });
		const c = await seedEmployee(db, hr, { managerId: b });
		const eb = (await getEmployee(db, b))!;
		await act(
			edit.actions.delete,
			w.users.hr,
			b,
			{ expectedUpdatedAt: String(eb.updatedAt), confirm: 'on' },
			`/people/${b}/edit`
		);
		const ea = (await getEmployee(db, a))!;
		expect(await updateWork(db, hr, ea, { managerId: c }, ea.updatedAt, Date.now())).toMatchObject({
			ok: false,
			reason: 'invalid'
		});
		await raw.prepare('UPDATE employees SET manager_id = ?1 WHERE id = ?2').bind(c, a).run();
		const restored = await act(
			edit.actions.restore,
			w.users.hr,
			b,
			{ expectedUpdatedAt: String((await getEmployee(db, b))!.updatedAt) },
			`/people/${b}/edit`
		);
		expect(status(restored)).toBe(400);
		expect((await getEmployee(db, b))!.deletedAt).not.toBeNull();
		expect((await auditRows(db, { employeeId: b })).map((r) => r.action)).not.toContain(
			'employee_restore'
		);
	});
});
