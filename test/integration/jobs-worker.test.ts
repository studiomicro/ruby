import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, type Db } from '#lib/server/db';
import { createReminder, jobsLastRun } from '#lib/server/reminders/repo';
import worker from '../../workers/jobs/src/index';
import { openLocalD1 } from '../helpers/d1';
import { at, clearCalendar, JKT, reminderNotifications } from '../helpers/seed-calendar';
import { insertUser } from '../helpers/users';

/**
 * The `ruby-jobs` Worker's handlers (workers/jobs/src/index.ts) against local D1: a simulated cron tick with a
 * scheduled time in the future delivers a due reminder; the fetch handler is a bare 404 (no HTTP surface).
 */

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;

beforeAll(async () => {
	const opened = await openLocalD1();
	d1 = opened.db;
	db = getDb(opened.db);
	dispose = opened.dispose;
});
afterAll(() => dispose());
beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	await clearCalendar(db);
});

/** The Worker's handlers as the runtime calls them. */
const handler = worker as unknown as {
	scheduled: (c: ScheduledController, env: unknown, ctx: ExecutionContext) => Promise<void>;
	fetch: (r: Request, env: unknown, ctx: ExecutionContext) => Response | Promise<Response>;
};
const env = () => ({ DB: d1, TEAM_TIME_ZONE: JKT, REMINDER_EMAIL_FROM: '' });
const ctx = {} as ExecutionContext;
const tick = (scheduledTime: number) =>
	handler.scheduled(
		{ scheduledTime, cron: '* * * * *', noRetry() {} } as ScheduledController,
		env(),
		ctx
	);

describe('ruby-jobs', () => {
	it('a cron tick at a simulated later minute delivers the due reminder once', async () => {
		const user = await insertUser(db);
		const now = Date.now();
		const fire = now + 5 * 60_000;
		const made = await createReminder(
			db,
			user.id,
			{ kind: 'personal', title: 'Water the plants', remindAt: fire },
			now,
			JKT
		);
		expect(made.ok).toBe(true);
		await tick(now); // not due yet: the real clock is earlier than the fire time
		expect(await reminderNotifications(db)).toHaveLength(0);
		await tick(fire);
		await tick(fire + 60_000);
		const sent = await reminderNotifications(db, user.id);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.summary).toBe('Water the plants');
		expect(await jobsLastRun(db)).toBeGreaterThanOrEqual(fire);
	});

	it('never runs earlier than the real clock: a scheduled time in the past uses Date.now()', async () => {
		const user = await insertUser(db);
		const now = Date.now();
		await createReminder(
			db,
			user.id,
			{ kind: 'personal', title: 'Later', remindAt: now + 120_000 },
			now,
			JKT
		);
		await tick(at('2000-01-01', '00:00'));
		expect(await reminderNotifications(db)).toHaveLength(0);
		expect(await jobsLastRun(db)).toBeGreaterThanOrEqual(now);
	});

	it('has no HTTP surface', async () => {
		const res = await handler.fetch(
			new Request('https://ruby-jobs.example/__scheduled'),
			env(),
			ctx
		);
		expect(res.status).toBe(404);
	});
});
