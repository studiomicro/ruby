import { pbkdf2Sync, randomBytes } from 'node:crypto';

/** The local review accounts' password (local D1 only; `npm run db:seed:local` never touches production). */
export const SEED_PASSWORD = 'ruby-local-demo';
/** Same derivation as src/lib/server/auth/password.ts (PBKDF2-HMAC-SHA256, 100,000 iterations, 16-byte salt). */
const ITERATIONS = 100_000;

/** Fictional local accounts, fixed ids so a re-seed changes nothing. */
export const SEED_USERS = [
	{
		id: '00000000-0000-4000-8000-00000000a001',
		email: 'admin@example.test',
		name: 'Ada Admin',
		role: 'admin'
	},
	{
		id: '00000000-0000-4000-8000-00000000a002',
		email: 'member@example.test',
		name: 'Max Member',
		role: 'member'
	},
	// A second admin used only by the e2e raw-HTTP probe (rb03-qa.spec.ts), so its comment budget is its own.
	{
		id: '00000000-0000-4000-8000-00000000a003',
		email: 'qa-admin@example.test',
		name: 'Quinn QA',
		role: 'admin'
	}
] as const;

/**
 * Fictional employees for the RB-05 directory and org chart (three levels). Ada Admin and Max Member are linked to
 * the seeded accounts; only tier 0 and tier 1 fields are seeded (tier 2 needs HR_DATA_KEY and goes through the app).
 */
export const SEED_EMPLOYEES = [
	[
		'00000000-0000-4000-8000-0000000e0001',
		'Ada Admin',
		'Managing director',
		'Leadership',
		null,
		SEED_USERS[0].id,
		'MTP-001'
	],
	[
		'00000000-0000-4000-8000-0000000e0002',
		'Bayu Fiktif',
		'Head of engineering',
		'Engineering',
		'00000000-0000-4000-8000-0000000e0001',
		null,
		'MTP-002'
	],
	[
		'00000000-0000-4000-8000-0000000e0003',
		'Max Member',
		'Software engineer',
		'Engineering',
		'00000000-0000-4000-8000-0000000e0002',
		SEED_USERS[1].id,
		'MTP-003'
	],
	[
		'00000000-0000-4000-8000-0000000e0004',
		'Citra Contoh',
		'Product designer',
		'Engineering',
		'00000000-0000-4000-8000-0000000e0002',
		null,
		'MTP-004'
	],
	[
		'00000000-0000-4000-8000-0000000e0005',
		'Dewi Sampel',
		'Head of operations',
		'Operations',
		'00000000-0000-4000-8000-0000000e0001',
		null,
		'MTP-005'
	],
	[
		'00000000-0000-4000-8000-0000000e0006',
		'Eko Teladan',
		'Operations analyst',
		'Operations',
		'00000000-0000-4000-8000-0000000e0005',
		null,
		'MTP-006'
	]
] as const;

/**
 * The seed's SQL statements: the `app_meta` marker and the two fictional accounts with SEED_PASSWORD, each written
 * only when absent (`on conflict do nothing`), so a seed never overwrites a local account or password. Every value
 * is a constant of this file or a base64 digest; nothing from outside is spliced in.
 */
export function seedStatements(now: number): string[] {
	const statements = [
		`INSERT INTO app_meta (key, value, updated_at) VALUES ('seed', 'v1', ${now}) ` +
			'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
	];
	for (const user of SEED_USERS) {
		const salt = randomBytes(16);
		const hash = pbkdf2Sync(SEED_PASSWORD, salt, ITERATIONS, 32, 'sha256').toString('base64');
		statements.push(
			// The first admin is also HR (owner answer 2026-10-26: the owner's admin account is the only HR user).
			`INSERT INTO users (id, email, name, role, status, created_at, is_hr) VALUES ('${user.id}', '${user.email}', ` +
				`'${user.name}', '${user.role}', 'active', ${now}, ${user.id === SEED_USERS[0].id ? 1 : 0}) ON CONFLICT DO NOTHING`,
			`INSERT INTO user_passwords (user_id, algo, hash, salt, iterations, failed_count, updated_at) ` +
				`SELECT '${user.id}', 'pbkdf2-sha256', '${hash}', '${salt.toString('base64')}', ${ITERATIONS}, 0, ${now} ` +
				`WHERE EXISTS (SELECT 1 FROM users WHERE id = '${user.id}') ON CONFLICT DO NOTHING`
		);
	}
	for (const [id, name, title, department, managerId, userId, number] of SEED_EMPLOYEES)
		statements.push(
			`INSERT INTO employees (id, user_id, employee_no, full_name, job_title, department, location, work_email, ` +
				`manager_id, employment_type, status, start_on, created_by, created_at, updated_at) VALUES ('${id}', ` +
				`${userId ? `'${userId}'` : 'NULL'}, '${number}', '${name}', '${title}', '${department}', 'Jakarta', ` +
				`'${number.toLowerCase()}@example.test', ${managerId ? `'${managerId}'` : 'NULL'}, 'permanent', 'active', ` +
				`'2024-01-15', '${SEED_USERS[0].id}', ${now}, ${now}) ON CONFLICT DO NOTHING`
		);
	return statements;
}
