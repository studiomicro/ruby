/** URLs of the Issues page built from the current query (plain functions, no reactive state). */

/** The query without SvelteKit's `/action` keys and the page number. */
function cleanQuery(search: string): URLSearchParams {
	const q = new URLSearchParams(search);
	for (const k of [...q.keys()]) if (k.startsWith('/')) q.delete(k);
	q.delete('page');
	return q;
}

const href = (q: URLSearchParams) => {
	const s = q.toString();
	return `/issues${s ? `?${s}` : ''}`;
};

/** The current filters without one value of `key` (all of them when `value` is omitted): a filter chip's "remove". */
export function withoutFilter(search: string, key: string, value?: string): string {
	const q = cleanQuery(search);
	const kept = value === undefined ? [] : q.getAll(key).filter((v) => v !== value);
	q.delete(key);
	for (const v of kept) q.append(key, v);
	return href(q);
}

/** The current filters on another page (1: no `page` key). */
export function issuesPage(search: string, page: number): string {
	const q = cleanQuery(search);
	if (page > 1) q.set('page', String(page));
	return href(q);
}

/** `?<current query>&/<action>`: a no-JS form posts there and the answer re-renders the same filters. */
export function issuesAction(search: string, action: string): string {
	const s = cleanQuery(search).toString();
	return `?${s ? `${s}&` : ''}/${action}`;
}

/** The current filters as hidden inputs of another GET form (the sort form), without `skip` keys. */
export function hiddenParams(search: string, skip: readonly string[]): [string, string][] {
	return [...cleanQuery(search)].filter(([k]) => !skip.includes(k));
}
