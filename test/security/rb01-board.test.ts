import { and, asc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, type Db } from '#lib/server/db';
import { tasks } from '#lib/server/db/schema';
import { moveTask } from '#lib/server/tasks/repo';
import { needsRenumber, positionBetween, RENUMBER_GAP } from '#lib/server/tasks/position';
import { renderMarkdown } from '#lib/shared/markdown';
import { openLocalD1 } from '../helpers/d1';
import { clearAll, seedProject, seedTask } from '../helpers/seed-tasks';
import { insertUser } from '../helpers/users';

/**
 * Red-team probes for RB-01 board positions (precision exhaustion from repeated midpoint moves, ties from
 * concurrent drops) and Markdown in task descriptions. See docs/features/rb-01-projects-tasks/SECURITY_REPORT.md.
 */

const binding: { DB?: D1Database; TEAM_TIME_ZONE: string } = { TEAM_TIME_ZONE: 'UTC' };
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

let db: Db;
let dispose: () => Promise<void>;
beforeAll(async () => {
	const opened = await openLocalD1();
	binding.DB = opened.db;
	db = getDb(opened.db);
	dispose = opened.dispose;
});
afterAll(() => dispose());
beforeEach(() => clearAll(db));

async function column(projectId: string, status: 'todo' | 'done' = 'todo') {
	return db
		.select({ id: tasks.id, position: tasks.position, number: tasks.number })
		.from(tasks)
		.where(and(eq(tasks.projectId, projectId), eq(tasks.status, status), isNull(tasks.deletedAt)))
		.orderBy(asc(tasks.position), asc(tasks.number));
}

describe('board positions under attack', () => {
	it('400 alternating midpoint drops into one gap: positions stay finite, distinct and ordered (renumber kicks in)', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		const a = await seedTask(db, u, p);
		const b = await seedTask(db, u, p);
		const x = await seedTask(db, u, p);
		const y = await seedTask(db, u, p);
		// Squeeze: x after a, then y after a, then x after a … each halves the gap below a's successor.
		for (let i = 0; i < 400; i++) {
			const mover = i % 2 === 0 ? x : y;
			const r = await moveTask(db, p, mover.id, 'todo', { after: a.id }, Date.now());
			expect(r.ok).toBe(true);
			const col = await column(p.id);
			expect(col[0]?.id).toBe(a.id);
			expect(col[1]?.id).toBe(mover.id);
			for (let k = 1; k < col.length; k++) {
				expect(Number.isFinite(col[k]!.position)).toBe(true);
				expect(col[k]!.position - col[k - 1]!.position).toBeGreaterThan(0);
			}
		}
		expect((await column(p.id)).map((t) => t.id).at(-1)).toBe(b.id);
	}, 120_000); // 400 sequential D1 round trips: slow when other suites run in parallel.

	it('top/bottom churn only walks positions by 1024 per move (no exponent growth)', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		const a = await seedTask(db, u, p);
		const b = await seedTask(db, u, p);
		for (let i = 0; i < 200; i++)
			await moveTask(db, p, i % 2 ? a.id : b.id, 'todo', { place: 'top' }, Date.now());
		const col = await column(p.id);
		expect(Math.abs(col[0]!.position)).toBeLessThan(1024 * 210);
	});

	it('ties from concurrent drops are resolved: dropping after a tied card renumbers instead of colliding', async () => {
		const u = await insertUser(db);
		const p = await seedProject(db, u);
		const a = await seedTask(db, u, p);
		const b = await seedTask(db, u, p);
		const c = await seedTask(db, u, p);
		const m = await seedTask(db, u, p, { status: 'done' });
		await db.update(tasks).set({ position: 5 }).where(eq(tasks.projectId, p.id));
		await moveTask(db, p, m.id, 'todo', { after: a.id }, Date.now());
		const ids = (await column(p.id)).map((t) => t.id);
		expect(ids).toEqual([a.id, m.id, b.id, c.id]);
	});

	it('positionBetween/needsRenumber at float limits never yield NaN or an out-of-range midpoint', () => {
		for (const [lo, hi] of [
			[0, RENUMBER_GAP],
			[1e15, 1e15 + 0.25],
			[-1e15, -1e15 + 0.25],
			[Number.MAX_SAFE_INTEGER - 2048, Number.MAX_SAFE_INTEGER]
		] as const) {
			const mid = positionBetween(lo, hi);
			expect(Number.isNaN(mid)).toBe(false);
			expect(mid >= lo && mid <= hi).toBe(true);
		}
		expect(needsRenumber(1, 1)).toBe(true);
		expect(needsRenumber(1, 1 + RENUMBER_GAP / 2)).toBe(true);
	});
});

describe('Markdown in task descriptions', () => {
	it('script, event handlers and dangerous URL schemes render inert', () => {
		const vectors = [
			'<script>alert(1)</script>',
			'<img src=x onerror=alert(1)>',
			'[x](javascript:alert(1))',
			'[x](JaVaScRiPt:alert(1))',
			'[x](&#106;avascript:alert(1))',
			'[x](java\tscript:alert(1))',
			'[x](vbscript:msgbox(1))',
			'[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
			'![x](data:image/svg+xml,<svg onload=alert(1)>)',
			'[x][r]\n\n[r]: javascript:alert(1)',
			'<javascript:alert(1)>',
			'[x](//evil.example/a)',
			'[x](\\\\evil.example)',
			'`<script>`',
			'[<img src=x onerror=alert(1)>](https://ok.example)'
		];
		for (const v of vectors) {
			const html = renderMarkdown(v);
			expect(html, v).not.toMatch(
				/<script|<[a-z][^>]*\son\w+=|href="(javascript|vbscript|data):|src="data:|href="\/\/|<img[^>]+src="x"/i
			);
		}
	});
});
