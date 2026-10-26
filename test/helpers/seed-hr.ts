import type { SessionUser } from '#lib/server/auth/session';
import type { Db } from '#lib/server/db';
import { createEmployee } from '#lib/server/hr/repo';
import type { WorkFields } from '#lib/server/hr/validation';
import { insertUser } from './users';

/**
 * RB-05 fixtures: fictional people only. `hrWorld` builds the PRD's cast: an admin (not HR), an HR user, a
 * three-level chain top → manager → report (each linked to an account), a skip-level viewer (top), an outsider, a
 * disabled user and an unlinked contractor reporting to the manager.
 */

let counter = 0;

export async function grantHr(db: Db, userId: string) {
	await db.$client.prepare('UPDATE users SET is_hr = 1 WHERE id = ?1').bind(userId).run();
}

export const work = (overrides: Partial<WorkFields> = {}): WorkFields => ({
	fullName: `Fictional Person ${(counter += 1)}`,
	preferredName: null,
	jobTitle: null,
	department: null,
	location: null,
	workEmail: null,
	workPhone: null,
	employeeNo: null,
	employmentType: 'permanent',
	startOn: null,
	probationEndsOn: null,
	managerId: null,
	...overrides
});

export async function seedEmployee(
	db: Db,
	actorId: string,
	overrides: Partial<WorkFields> = {},
	userId: string | null = null
): Promise<string> {
	const created = await createEmployee(db, actorId, work(overrides), Date.now());
	if (!created.ok || !created.id) throw new Error('seedEmployee failed');
	if (userId)
		await db.$client
			.prepare('UPDATE employees SET user_id = ?1 WHERE id = ?2')
			.bind(userId, created.id)
			.run();
	return created.id;
}

export async function hrWorld(db: Db) {
	const tag = `${Date.now().toString(36)}${(counter += 1)}`;
	const admin = await insertUser(db, { role: 'admin', name: `Admin ${tag}` });
	const hr: SessionUser = await insertUser(db, { name: `HR ${tag}` });
	await grantHr(db, hr.id);
	const topUser = await insertUser(db, { name: `Top ${tag}` });
	const managerUser = await insertUser(db, { name: `Manager ${tag}` });
	const reportUser = await insertUser(db, { name: `Report ${tag}` });
	const outsider = await insertUser(db, { name: `Outsider ${tag}` });
	const disabled = await insertUser(db, { name: `Disabled ${tag}`, status: 'disabled' });
	const department = `Dept ${tag}`;
	const top = await seedEmployee(
		db,
		hr.id,
		{ fullName: `Top Person ${tag}`, department },
		topUser.id
	);
	const manager = await seedEmployee(
		db,
		hr.id,
		{ fullName: `Manager Person ${tag}`, department, managerId: top },
		managerUser.id
	);
	const report = await seedEmployee(
		db,
		hr.id,
		{
			fullName: `Report Person ${tag}`,
			department,
			managerId: manager,
			employeeNo: `EMP-${tag}`,
			startOn: '2024-03-04',
			jobTitle: 'Fictional analyst'
		},
		reportUser.id
	);
	const contractor = await seedEmployee(db, hr.id, {
		fullName: `Contractor Person ${tag}`,
		department,
		managerId: manager,
		employmentType: 'contract'
	});
	return {
		tag,
		department,
		users: { admin, hr, topUser, managerUser, reportUser, outsider, disabled },
		employees: { top, manager, report, contractor }
	};
}

/** Audit rows about `employeeId` (or by `actorId`), oldest first. */
export async function auditRows(db: Db, where: { employeeId?: string; actorId?: string }) {
	const { results } = await db.$client
		.prepare(
			`SELECT action, actor_id AS actorId, employee_id AS employeeId, user_id AS userId, fields, detail
			 FROM hr_audit_log WHERE (?1 IS NULL OR employee_id = ?1) AND (?2 IS NULL OR actor_id = ?2)
			 ORDER BY at, rowid`
		)
		.bind(where.employeeId ?? null, where.actorId ?? null)
		.all<{
			action: string;
			actorId: string;
			employeeId: string | null;
			userId: string | null;
			fields: string;
			detail: string;
		}>();
	return results;
}
