import { cleanText } from '#lib/shared/text';
import { MENTION_QUERY_MAX } from '#lib/shared/comments';
import type { Db } from '../db';

/** Users the picker lists at most. */
export const MENTION_RESULTS_MAX = 8;
/** Picker lookups one user may make per minute (a debounced picker sends a few per mention; red team L2). */
export const MENTION_SEARCH_PER_MINUTE = 60;

/**
 * Active users whose name contains `q` (case-insensitive; empty `q` matches everyone), names starting with it first,
 * then by name; at most MENTION_RESULTS_MAX, id and name only. `instr`, not LIKE: no pattern characters and no
 * D1 pattern-length limit to worry about.
 */
export async function searchMentionUsers(
	db: Db,
	q: string
): Promise<{ id: string; name: string }[]> {
	const term = cleanText(q, MENTION_QUERY_MAX).toLowerCase();
	const { results } = await db.$client
		.prepare(
			`SELECT id, name FROM users
			 WHERE status = 'active' AND instr(lower(name), ?1) > 0
			 ORDER BY instr(lower(name), ?1) = 1 DESC, lower(name), id
			 LIMIT ?2`
		)
		.bind(term, MENTION_RESULTS_MAX)
		.all<{ id: string; name: string }>();
	return results;
}
