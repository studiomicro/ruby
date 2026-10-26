import { error } from '@sveltejs/kit';
import {
	overUserAttemptLimit,
	overUserMinuteLimit,
	retryAfterSeconds,
	THROTTLE_MINUTE_MS,
	THROTTLE_WINDOW_MS
} from '#lib/server/auth/throttle';
import { requireUser } from '#lib/server/guards';
import { buildMatchQuery, normaliseQuery, parseSearchType } from '#lib/server/search/query';
import {
	searchAll,
	SEARCH_MINUTE_MAX,
	SEARCH_THROTTLE_MAX,
	TOO_MANY_SEARCHES,
	type SearchResults
} from '#lib/server/search/repo';
import { errorLabel, now } from '#lib/server/util';
import type { PageServerLoad } from './$types';

type SearchState =
	{ state: 'initial' | 'too-short' | 'unavailable' } | { state: 'results'; results: SearchResults };

/** GET `?q=&type=all|pages|tasks`. An FTS failure is logged by class only (never the query) and shown as a banner. */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const db = event.locals.db;
	const q = normaliseQuery(event.url.searchParams.get('q') ?? '');
	const type = parseSearchType(event.url.searchParams.get('type'));
	const base = { q, type };
	if (!q) return { ...base, state: 'initial' } satisfies SearchState & typeof base;
	if (!buildMatchQuery(q)) return { ...base, state: 'too-short' } as SearchState & typeof base;
	const at = now();
	// The per-minute budget first: a refused burst does not also spend the 10-minute one.
	const window = (await overUserMinuteLimit(db, user.id, at, 'search', SEARCH_MINUTE_MAX))
		? THROTTLE_MINUTE_MS
		: (await overUserAttemptLimit(db, user.id, at, 'search', SEARCH_THROTTLE_MAX))
			? THROTTLE_WINDOW_MS
			: null;
	if (window !== null) {
		event.setHeaders({ 'retry-after': String(retryAfterSeconds(at, window)) });
		error(429, TOO_MANY_SEARCHES);
	}
	try {
		const results = await searchAll(db, q, { type });
		return { ...base, state: 'results', results } as SearchState & typeof base;
	} catch (e) {
		console.error('search failed', errorLabel(e));
		return { ...base, state: 'unavailable' } as SearchState & typeof base;
	}
};
