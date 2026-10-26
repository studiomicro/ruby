import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { dispatchDue } from '#lib/server/reminders/dispatch';
import { createReminder } from '#lib/server/reminders/repo';
import { DAY_MS } from '#lib/shared/calendar';
import { openLocalD1 } from '../helpers/d1';
import {
	at,
	clearCalendar,
	JKT,
	reminderNotifications,
	reminderRow
} from '../helpers/seed-calendar';
import { seedProject, seedTask } from '../helpers/seed-tasks';
import { insertUser } from '../helpers/users';

/** RB-09 QA: the 24 h late window edges, the exact tick, and the 09:00 WIB task anchor, through the real scheduler. */
let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
let owner: SessionUser;
const T0 = at('2026-11-02', '08:00');
const run = (now: number) => dispatchDue(d1, now, { zone: JKT, email: null });
const personal = async (title: string, remindAt: number) => {
	const r = await createReminder(db, owner.id, { kind: 'personal', title, remindAt }, T0, JKT);
	if (!r.ok) throw new Error(r.reason);
	return r.id;
};

beforeAll(async () => {
	const o = await openLocalD1();
	d1 = o.db;
	db = getDb(o.db);
	dispose = o.dispose;
});
afterAll(() => dispose());
beforeEach(async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	await clearCalendar(db);
	owner = await insertUser(db, { name: 'Qa Owner' });
});

describe('RB-09 QA dispatch edges', () => {
	it('exactly at the tick sends; 1 ms before does not', async () => {
		const fire = at('2026-11-02', '09:30');
		const id = await personal('tick', fire);
		await run(fire - 1);
		expect(await reminderRow(db, id)).toMatchObject({ outcome: null });
		await run(fire);
		expect(await reminderRow(db, id)).toMatchObject({ outcome: 'sent' });
	});
	it('late exactly 24 h is sent, 24 h + 1 ms is missed without a notification', async () => {
		const fire = at('2026-11-02', '09:30');
		const a = await personal('edge-a', fire);
		const b = await personal('edge-b', fire);
		await d1.prepare(`UPDATE reminders SET fire_at = fire_at WHERE id = ?`).bind(b).run();
		await run(fire + DAY_MS);
		// both were claimed in one run at +24h: both sent
		expect(await reminderRow(db, a)).toMatchObject({ outcome: 'sent' });
		expect(await reminderRow(db, b)).toMatchObject({ outcome: 'sent' });
		const c = await personal('edge-c', fire + 1000);
		await run(fire + 1000 + DAY_MS + 1);
		expect(await reminderRow(db, c)).toMatchObject({ outcome: 'missed' });
		expect((await reminderNotifications(db)).map((n) => n.summary)).not.toContain('edge-c');
	});
	it('task relative reminder anchors at 09:00 WIB (02:00Z) minus the offset', async () => {
		const p = await seedProject(db, owner);
		const task = await seedTask(db, owner, p, { dueOn: '2026-11-05', assigneeId: owner.id });
		const r = await createReminder(
			db,
			owner.id,
			{ kind: 'task', taskId: task.id, mode: 'relative', offset: 1440 },
			T0,
			JKT
		);
		if (!r.ok) throw new Error(r.reason);
		const row = await reminderRow(db, r.id);
		expect(new Date(Number(row!.fire_at)).toISOString()).toBe('2026-11-04T02:00:00.000Z');
	});
});
