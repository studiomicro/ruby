import { error, json } from '@sveltejs/kit';
import {
	overUserMinuteLimit,
	retryAfterSeconds,
	THROTTLE_MINUTE_MS
} from '#lib/server/auth/throttle';
import { requireUser } from '#lib/server/guards';
import { MENTION_SEARCH_PER_MINUTE, searchMentionUsers } from '#lib/server/comments/mentions';
import { MENTION_QUERY_MAX } from '#lib/shared/comments';
import { now } from '#lib/server/util';
import type { RequestHandler } from './$types';

/**
 * The mention picker's source: up to 8 active users `{ id, name }` whose name contains `q` (prefix matches first),
 * never e-mail addresses. `q` longer than MENTION_QUERY_MAX characters is a 400; past MENTION_SEARCH_PER_MINUTE
 * lookups a minute, 429 with Retry-After. Never cached.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const q = event.url.searchParams.get('q') ?? '';
	if (Array.from(q).length > MENTION_QUERY_MAX) error(400, 'Search text is too long.');
	const at = now();
	if (
		await overUserMinuteLimit(
			event.locals.db,
			user.id,
			at,
			'mention-search',
			MENTION_SEARCH_PER_MINUTE
		)
	)
		return json(
			{ error: 'Too many lookups, wait a moment.' },
			{
				status: 429,
				headers: {
					'cache-control': 'private, no-store',
					'retry-after': String(retryAfterSeconds(at, THROTTLE_MINUTE_MS))
				}
			}
		);
	const users = await searchMentionUsers(event.locals.db, q);
	return json({ users }, { headers: { 'cache-control': 'private, no-store' } });
};
