/** URLs of the project list/board views, built from the current query (plain functions, no reactive state). */

/** The query without SvelteKit's `/action` keys and the one-time `deleted` notice. */
function cleanQuery(search: string): URLSearchParams {
	const q = new URLSearchParams(search);
	for (const k of [...q.keys()]) if (k.startsWith('/')) q.delete(k);
	q.delete('deleted');
	return q;
}

/** The current view with some params changed (null removes one). */
export function withParams(base: string, search: string, changes: Record<string, string | null>) {
	const q = cleanQuery(search);
	for (const [k, v] of Object.entries(changes)) {
		q.delete(k);
		if (v !== null) q.set(k, v);
	}
	const s = q.toString();
	return `${base}${s ? `?${s}` : ''}`;
}

/** `?<current query>&/<action>`: a no-JS form posts there and the response re-renders the same view. */
export function actionUrl(search: string, action: string): string {
	const s = cleanQuery(search).toString();
	return `?${s ? `${s}&` : ''}/${action}`;
}

/** `?<current query>&/move`: a no-JS move posts there and the response re-renders the same view. */
export function moveActionUrl(search: string): string {
	return actionUrl(search, 'move');
}

type Assignee = 'any' | 'me' | 'none' | { userId: string };

/** The list view of one status, keeping the other filters (the board's "N more" link). */
export function statusListUrl(
	base: string,
	status: string,
	filters: {
		priorities: string[];
		assignee: Assignee;
		labels?: string[];
		milestone?: 'any' | 'none' | { id: string };
	}
): string {
	const q = new URLSearchParams();
	q.set('status', status);
	for (const p of filters.priorities) q.append('priority', p);
	const a = filters.assignee;
	if (a !== 'any') q.set('assignee', typeof a === 'string' ? a : a.userId);
	// RB-08: the label and milestone filters are kept too.
	for (const l of filters.labels ?? []) q.append('label', l);
	const m = filters.milestone ?? 'any';
	if (m !== 'any') q.set('milestone', m === 'none' ? 'none' : m.id);
	return `${base}?${q}`;
}
