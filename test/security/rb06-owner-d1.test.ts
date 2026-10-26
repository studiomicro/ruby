import { isHttpError } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '#lib/server/auth/session';
import { getDb, type Db } from '#lib/server/db';
import { addDays, yearOf } from '#lib/server/timeoff/calendar';
import { balancesFor, decidableCount, decide } from '#lib/server/timeoff/repo';
import { loadViewer } from '#lib/server/hr/access';
import { teamToday } from '#lib/server/tasks/today';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { grantHr, seedEmployee } from '../helpers/seed-hr';
import { planBase, requestAs, requestRow } from '../helpers/seed-leave';
import { insertUser } from '../helpers/users';

/**
 * RB-06 red team, cycle 1, finding L1 (engineer note): the production cast of owner answer 2026-10-26 on a fresh D1,
 * the owner being the only admin and the only HR user, with one member reporting to the owner. Cycle 2 (owner
 * decision 10 addendum): the owner self-approves their own request, audited, while nobody else could.
 */

const binding: { DB?: D1Database; TEAM_TIME_ZONE: string } = { TEAM_TIME_ZONE: 'Asia/Jakarta' };
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const mine = await import('../../src/routes/(app)/time-off/+page.server');
const approvals = await import('../../src/routes/(app)/time-off/approvals/+page.server');

let db: Db;
let dispose: () => Promise<void>;
let owner: SessionUser;
let member: SessionUser;
let base: string;
beforeAll(async () => {
	const opened = await openLocalD1();
	binding.DB = opened.db;
	db = getDb(opened.db);
	dispose = opened.dispose;
	base = planBase(teamToday());
	owner = await insertUser(db, { role: 'admin', name: 'Owner Fictional' });
	await grantHr(db, owner.id);
	member = await insertUser(db, { name: 'Member Fictional' });
	const ownerEmployee = await seedEmployee(
		db,
		owner.id,
		{ fullName: 'Owner Person', startOn: '2020-01-01' },
		owner.id
	);
	await seedEmployee(
		db,
		owner.id,
		{ fullName: 'Member Person', startOn: '2020-01-01', managerId: ownerEmployee },
		member.id
	);
});
afterAll(() => dispose());

const run = async (fn: unknown, event: unknown) => {
	try {
		return await (fn as (e: never) => unknown)(event as never);
	} catch (e) {
		return e;
	}
};
const req = (user: SessionUser, path: string, form?: Record<string, string>) =>
	fakeEvent({ url: `http://localhost${path}`, db, user, form }).event;

describe('sole owner = only admin and only HR', () => {
	it('the member’s request is decided by the owner (manager path) as designed', async () => {
		const made = await requestAs(db, member, { startOn: base });
		if (!made.ok) throw new Error('request failed');
		expect(await decidableCount(db, owner.id)).toBe(1);
		const row = (await requestRow(db, made.id))!;
		const r = await run(
			approvals.actions.approve,
			req(owner, '/time-off/approvals?/approve', { id: made.id, expected: String(row.updatedAt) })
		);
		expect((r as { decided?: string }).decided).toBe('Request approved.');
	});

	it('FIXED L1 (owner decision 10 addendum): the owner self-approves their own request, audited and marked', async () => {
		const made = await requestAs(db, owner, { startOn: addDays(base, 7) });
		if (!made.ok) throw new Error('request failed');
		const expected = String((await requestRow(db, made.id))!.updatedAt);
		// The owner sees it in their own queue and badge; the member cannot decide it.
		expect(await decidableCount(db, owner.id)).toBe(1);
		expect(await decidableCount(db, member.id)).toBe(0);
		const byMember = await run(
			approvals.actions.approve,
			req(member, '/time-off/approvals?/approve', { id: made.id, expected })
		);
		expect(isHttpError(byMember) && byMember.status).toBe(404);
		const page = (await run(mine.load, req(owner, '/time-off'))) as { selfApproval: boolean };
		expect(page.selfApproval).toBe(true);
		const queue = (await run(approvals.load, req(owner, '/time-off/approvals'))) as {
			selfApproval: boolean;
			queue: { id: string; own: boolean }[];
		};
		expect(queue.selfApproval).toBe(true);
		expect(queue.queue.find((q) => q.id === made.id)?.own).toBe(true);

		const r = await run(
			approvals.actions.approve,
			req(owner, '/time-off/approvals?/approve', { id: made.id, expected })
		);
		expect((r as { decided?: string }).decided).toBe('Request approved.');
		const row = await db.$client
			.prepare(
				'SELECT status, self_approved AS selfApproved, decided_by AS decidedBy FROM leave_requests WHERE id = ?1'
			)
			.bind(made.id)
			.first<{ status: string; selfApproved: number; decidedBy: string }>();
		expect(row).toEqual({ status: 'approved', selfApproved: 1, decidedBy: owner.id });
		const audit = await db.$client
			.prepare(
				`SELECT action, actor_id AS actorId, user_id AS userId, detail FROM hr_audit_log WHERE action = 'leave_self_approve'`
			)
			.all<{ action: string; actorId: string; userId: string; detail: string }>();
		expect(audit.results).toEqual([
			{
				action: 'leave_self_approve',
				actorId: owner.id,
				userId: owner.id,
				detail: 'approved · self'
			}
		]);
		const ownerEmployee = (await db.$client
			.prepare('SELECT id FROM employees WHERE user_id = ?1')
			.bind(owner.id)
			.first<{ id: string }>())!.id;
		const [held] = await balancesFor(db, [ownerEmployee], yearOf(addDays(base, 7)));
		expect(held).toMatchObject({ used: 2, pending: 0 });
		const after = (await run(mine.load, req(owner, '/time-off'))) as {
			requests: { id: string; selfApproved: boolean }[];
		};
		expect(after.requests.find((x) => x.id === made.id)?.selfApproved).toBe(true);
	});

	it('N1: another active admin switches self-approval off; that admin decides instead', async () => {
		const made = await requestAs(db, owner, { startOn: addDays(base, 21) });
		if (!made.ok) throw new Error('request failed');
		const expected = String((await requestRow(db, made.id))!.updatedAt);
		const admin2 = await insertUser(db, { role: 'admin', name: 'Second Admin Fictional' });
		try {
			expect(await decidableCount(db, owner.id)).toBe(0);
			expect(await decidableCount(db, admin2.id)).toBe(1);
			const page = (await run(mine.load, req(owner, '/time-off'))) as { selfApproval: boolean };
			expect(page.selfApproval).toBe(false);
			const self = await run(
				approvals.actions.approve,
				req(owner, '/time-off/approvals?/approve', { id: made.id, expected })
			);
			expect(isHttpError(self) && self.status).toBe(404);
			const byAdmin = await run(
				approvals.actions.approve,
				req(admin2, '/time-off/approvals?/approve', { id: made.id, expected })
			);
			expect((byAdmin as { decided?: string }).decided).toBe('Request approved.');
			const row = await db.$client
				.prepare('SELECT self_approved AS s, decided_by AS d FROM leave_requests WHERE id = ?1')
				.bind(made.id)
				.first<{ s: number; d: string }>();
			expect(row).toEqual({ s: 0, d: admin2.id });
		} finally {
			await db.$client
				.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?1`)
				.bind(admin2.id)
				.run();
		}
	});

	it('N1 race: an admin promoted while a self-approve is in flight makes the guarded write refuse it', async () => {
		const made = await requestAs(db, owner, { startOn: addDays(base, 28) });
		if (!made.ok) throw new Error('request failed');
		const expected = (await requestRow(db, made.id))!.updatedAt;
		const viewer = await loadViewer(db, owner);
		let promoted = false;
		const client = new Proxy(db.$client, {
			get(target, prop) {
				if (prop === 'batch')
					return async (statements: D1PreparedStatement[]) => {
						if (!promoted) {
							promoted = true;
							await target
								.prepare(`UPDATE users SET role = 'admin' WHERE id = ?1`)
								.bind(member.id)
								.run();
						}
						return target.batch(statements);
					};
				const value = Reflect.get(target, prop) as unknown;
				return typeof value === 'function'
					? (value as (...a: unknown[]) => unknown).bind(target)
					: value;
			}
		});
		try {
			const result = await decide(
				{ $client: client } as unknown as Db,
				viewer,
				made.id,
				'approve',
				'',
				expected,
				Date.now()
			);
			expect(promoted).toBe(true);
			expect(result).toEqual({ ok: false, reason: 'not_found' });
			expect((await requestRow(db, made.id))!.status).toBe('pending');
			const audit = await db.$client
				.prepare(
					`SELECT count(*) AS n FROM hr_audit_log WHERE action IN ('leave_self_approve', 'leave_self_reject') AND employee_id = (SELECT employee_id FROM leave_requests WHERE id = ?1) AND at >= ?2`
				)
				.bind(made.id, expected)
				.first<{ n: number }>();
			expect(audit!.n).toBe(0);
		} finally {
			await db.$client
				.prepare(`UPDATE users SET role = 'member' WHERE id = ?1`)
				.bind(member.id)
				.run();
		}
	});

	it('I4: a self-reject is logged as leave_self_reject, not as a self-approval', async () => {
		const made = await requestAs(db, owner, { startOn: addDays(base, 35) });
		if (!made.ok) throw new Error('request failed');
		const expected = String((await requestRow(db, made.id))!.updatedAt);
		const r = await run(
			approvals.actions.reject,
			req(owner, '/time-off/approvals?/reject', { id: made.id, expected })
		);
		expect((r as { decided?: string }).decided).toBe('Request rejected.');
		const rows = await db.$client
			.prepare(
				`SELECT action, detail, user_id AS userId FROM hr_audit_log WHERE action = 'leave_self_reject'`
			)
			.all<{ action: string; detail: string; userId: string }>();
		expect(rows.results).toEqual([
			{ action: 'leave_self_reject', detail: 'rejected · self', userId: owner.id }
		]);
		expect((await requestRow(db, made.id))!.status).toBe('rejected');
	});

	it('self-approval switches off once a second HR user exists (and the guarded write re-checks it)', async () => {
		const made = await requestAs(db, owner, { startOn: addDays(base, 14) });
		if (!made.ok) throw new Error('request failed');
		const expected = String((await requestRow(db, made.id))!.updatedAt);
		const second = await insertUser(db, { name: 'Second HR Fictional' });
		await grantHr(db, second.id);
		try {
			expect(await decidableCount(db, owner.id)).toBe(0);
			const page = (await run(mine.load, req(owner, '/time-off'))) as { selfApproval: boolean };
			expect(page.selfApproval).toBe(false);
			const r = await run(
				approvals.actions.approve,
				req(owner, '/time-off/approvals?/approve', { id: made.id, expected })
			);
			expect(isHttpError(r) && r.status).toBe(404);
			expect((await requestRow(db, made.id))!.status).toBe('pending');
			const by2 = await run(
				approvals.actions.approve,
				req(second, '/time-off/approvals?/approve', { id: made.id, expected })
			);
			expect((by2 as { decided?: string }).decided).toBe('Request approved.');
		} finally {
			await db.$client.prepare('UPDATE users SET is_hr = 0 WHERE id = ?1').bind(second.id).run();
		}
	});
});
