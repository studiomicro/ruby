import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '.';

/**
 * A `db.batch` item that aborts the whole batch unless `condition` holds once the items before it ran. D1 runs a
 * batch as one transaction and rolls every item back when one fails; SQLite has no RAISE outside triggers, so
 * the failing branch evaluates `json()` on text that is not JSON (an error, caught by `isBatchAssertFailure`).
 * Used where a multi-row write must be all or nothing.
 */
export function batchAssert(db: Db, condition: SQL) {
	// A select builder (D1's batch takes builders; a raw `db.run` item cannot carry parameters there).
	return db
		.select({
			ok: sql<number>`case when ${condition} then 1 else json('batch assertion failed') end`
		})
		.from(sql`(select 1)`);
}

/** True when a `db.batch` failed on a `batchAssert` item (nothing in that batch was written). */
export function isBatchAssertFailure(e: unknown): boolean {
	const message =
		String((e as Error)?.message ?? e) + String((e as { cause?: Error })?.cause?.message ?? '');
	return message.includes('malformed JSON');
}
