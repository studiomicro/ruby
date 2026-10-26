import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, openLocalD1 } from '../helpers/d1';

/**
 * Migration 0011 rebuilds the live `notifications` table (criterion 29): applied to a database that holds rows of
 * every older kind, it keeps each row byte for byte, the unread count and the index, adds the reminder columns and
 * CHECKs, and leaves no foreign-key violation.
 */

let d1: D1Database;
let dispose: () => Promise<void>;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOTIFICATION_COLUMNS =
	'id, user_id, kind, actor_id, target_kind, target_id, comment_id, created_at, read_at';

async function seedOldSchema(db: D1Database) {
	const t = 1_790_000_000_000;
	const statements = [
		`INSERT INTO users (id, email, name, role, status, created_at) VALUES ('${id(1)}', 'a@example.test', 'Ana', 'admin', 'active', ${t})`,
		`INSERT INTO users (id, email, name, role, status, created_at) VALUES ('${id(2)}', 'b@example.test', 'Bo', 'member', 'active', ${t})`,
		`INSERT INTO users (id, email, name, role, status, created_at) VALUES ('${id(3)}', 'c@example.test', 'Cy', 'member', 'disabled', ${t})`,
		`INSERT INTO projects (id, key, name, status, next_task_number, created_by, created_at, updated_at) VALUES ('${id(10)}', 'OPS', 'Ops', 'active', 2, '${id(1)}', ${t}, ${t})`,
		`INSERT INTO tasks (id, project_id, number, title, status, priority, position, created_by, created_at, updated_at) VALUES ('${id(20)}', '${id(10)}', 1, 'Fix login', 'todo', 'none', 1, '${id(1)}', ${t}, ${t})`,
		`INSERT INTO pages (id, title, body, position, revision, created_by, updated_by, created_at, updated_at) VALUES ('${id(30)}', 'Handbook', 'Body', 1, 1, '${id(1)}', '${id(1)}', ${t}, ${t})`,
		`INSERT INTO comments (id, target_kind, target_id, author_id, body, created_at, updated_at) VALUES ('${id(40)}', 'task', '${id(20)}', '${id(1)}', 'Hi @[Bo](user:${id(2)})', ${t}, ${t})`,
		`INSERT INTO comments (id, target_kind, target_id, author_id, body, created_at, updated_at, deleted_at) VALUES ('${id(41)}', 'page', '${id(30)}', '${id(2)}', 'Gone', ${t}, ${t}, ${t + 5})`
	];
	const rows: [
		number,
		string,
		string,
		string,
		string,
		string,
		string | null,
		number,
		number | null
	][] = [
		[100, id(2), 'mention', id(1), 'task', id(20), id(40), t + 1, null],
		[101, id(2), 'assigned', id(1), 'task', id(20), null, t + 2, t + 50],
		[102, id(1), 'comment', id(2), 'page', id(30), id(41), t + 3, null],
		[103, id(3), 'mention', id(1), 'task', id(20), id(40), t + 3, null],
		[104, id(1), 'comment', id(2), 'page', id(30), id(41), t + 4, t + 60]
	];
	for (const [n, user, kind, actor, tk, tid, comment, created, read] of rows)
		statements.push(
			`INSERT INTO notifications (${NOTIFICATION_COLUMNS}) VALUES ('${id(n)}', '${user}', '${kind}', '${actor}', '${tk}', '${tid}', ${comment ? `'${comment}'` : 'NULL'}, ${created}, ${read ?? 'NULL'})`
		);
	for (const s of statements) await db.prepare(s).run();
}

const snapshot = async (db: D1Database) =>
	(
		await db
			.prepare(
				`SELECT ${NOTIFICATION_COLUMNS}, typeof(created_at) AS tc FROM notifications ORDER BY id`
			)
			.all()
	).results;
const unread = async (db: D1Database) =>
	(
		await db
			.prepare(
				`SELECT user_id, count(*) AS n FROM notifications WHERE read_at IS NULL GROUP BY user_id ORDER BY user_id`
			)
			.all()
	).results;

let before: unknown[];
let unreadBefore: unknown[];
let indexesBefore: string[];

const indexNames = async (db: D1Database) =>
	(
		await db
			.prepare(
				`SELECT name FROM sqlite_master WHERE tbl_name = 'notifications' AND type = 'index' ORDER BY name`
			)
			.all<{ name: string }>()
	).results.map((r) => r.name);

beforeAll(async () => {
	const opened = await openLocalD1({ before: '0011' });
	d1 = opened.db;
	dispose = opened.dispose;
	await seedOldSchema(d1);
	before = await snapshot(d1);
	unreadBefore = await unread(d1);
	indexesBefore = await indexNames(d1);
	expect(before).toHaveLength(5);
	await applyMigration(d1, '0011_calendar_reminders.sql');
});
afterAll(() => dispose());

describe('0011 notifications rebuild', () => {
	it('keeps every row byte for byte and the unread counts', async () => {
		expect(await snapshot(d1)).toEqual(before);
		expect(await unread(d1)).toEqual(unreadBefore);
		const added = await d1
			.prepare(
				`SELECT count(*) AS n FROM notifications WHERE summary IS NULL AND reminder_id IS NULL AND occurrence_at IS NULL`
			)
			.first<{ n: number }>();
		expect(added?.n).toBe(5);
	});

	it('recreates the index and adds the reminder key; no foreign-key violation; no leftover table', async () => {
		const { results } = await d1
			.prepare(
				`SELECT name, sql FROM sqlite_master WHERE tbl_name = 'notifications' AND type = 'index' ORDER BY name`
			)
			.all<{ name: string; sql: string | null }>();
		// Every index the old table had (its primary-key autoindex included), plus the new reminder key.
		expect(indexesBefore).toContain('notifications_user_idx');
		expect(results.map((r) => r.name)).toEqual(
			[...indexesBefore, 'notifications_reminder_uq'].sort()
		);
		expect(results.find((r) => r.name === 'notifications_user_idx')?.sql).toMatch(
			/\(`user_id`,`read_at`,`created_at`\)/
		);
		expect((await d1.prepare(`PRAGMA foreign_key_check`).all()).results).toEqual([]);
		const leftover = await d1
			.prepare(`SELECT name FROM sqlite_master WHERE name = 'notifications_new'`)
			.first();
		expect(leftover).toBeNull();
		const cols = await d1.prepare(`PRAGMA table_info(notifications)`).all<{ name: string }>();
		expect(cols.results.map((c) => c.name)).toEqual([
			'id',
			'user_id',
			'kind',
			'actor_id',
			'target_kind',
			'target_id',
			'comment_id',
			'summary',
			'reminder_id',
			'occurrence_at',
			'created_at',
			'read_at'
		]);
	});

	it('the new CHECKs accept a reminder and refuse unknown kinds and target kinds', async () => {
		await d1
			.prepare(
				`INSERT INTO reminders (id, user_id, target_kind, target_id, mode, remind_at, title, fire_at, created_at, updated_at)
				 VALUES ('${id(500)}', '${id(1)}', 'personal', NULL, 'absolute', 5, 'x', 5, 1, 1)`
			)
			.run();
		const insert = (kind: string, targetKind: string, reminder: string | null, n: number) =>
			d1
				.prepare(
					`INSERT INTO notifications (id, user_id, kind, actor_id, target_kind, target_id, reminder_id, occurrence_at, created_at)
					 VALUES (?1, ?2, ?3, ?2, ?4, ?5, ?6, 5, 9)`
				)
				.bind(id(n), id(1), kind, targetKind, id(500), reminder)
				.run();
		await expect(insert('reminder', 'personal', id(500), 600)).resolves.toBeTruthy();
		await expect(insert('reminder', 'event', id(500), 601)).rejects.toThrow(/UNIQUE/);
		await expect(insert('bogus', 'task', null, 602)).rejects.toThrow(/CHECK/);
		await expect(insert('mention', 'calendar', null, 603)).rejects.toThrow(/CHECK/);
		// A purged reminder's notification keeps its row with `reminder_id` cleared (QA F1).
		await expect(insert('reminder', 'personal', null, 604)).resolves.toBeTruthy();
		await expect(insert('mention', 'task', id(500), 605)).rejects.toThrow(/CHECK/);
	});
});
