import { TASK_PRIORITIES, TASK_STATUSES, type ViewKind } from '#lib/shared/enums';
import { isUuid, SORT_DIRS, TASK_SORTS } from '../tasks/validation';
import { PM_LIMITS } from './validation';

/**
 * The stored form of a saved view's filters: only the whitelisted keys (`status`, `priority`, `assignee`, `label`,
 * `milestone`, `sort`, `dir`, `view`), each with a validated value, in a fixed order. Unknown keys and invalid values
 * are dropped (`x=<script>`, `sort=;drop`). The board ignores sort, so a board view keeps none. Null when the
 * result is longer than PM_LIMITS.viewQueryMax characters. Pure: a saved view's `query` is only ever this output.
 */
export function canonicalizeQuery(kind: ViewKind, raw: URLSearchParams): string | null {
	const q = new URLSearchParams();
	if (kind === 'board') q.set('view', 'board');
	const keep = (key: string, allowed: (v: string) => boolean, map = (v: string) => v) => {
		const seen = new Set<string>();
		for (const v of raw.getAll(key)) {
			if (!allowed(v)) continue;
			const value = map(v);
			if (seen.has(value)) continue;
			seen.add(value);
			q.append(key, value);
		}
	};
	const inList = (list: readonly string[]) => (v: string) => list.includes(v);
	const lower = (v: string) => v.toLowerCase();
	keep('status', inList(TASK_STATUSES));
	keep('priority', inList(TASK_PRIORITIES));
	const assignee = raw.get('assignee') ?? '';
	if (assignee === 'me' || assignee === 'none') q.set('assignee', assignee);
	else if (isUuid(assignee)) q.set('assignee', lower(assignee));
	keep('label', isUuid, lower);
	const milestone = raw.get('milestone') ?? '';
	if (milestone === 'none') q.set('milestone', 'none');
	else if (isUuid(milestone)) q.set('milestone', lower(milestone));
	if (kind === 'list') {
		const sort = raw.get('sort') ?? '';
		const dir = raw.get('dir') ?? '';
		if ((TASK_SORTS as readonly string[]).includes(sort)) q.set('sort', sort);
		if ((SORT_DIRS as readonly string[]).includes(dir)) q.set('dir', dir);
	}
	const out = q.toString();
	return out.length > PM_LIMITS.viewQueryMax ? null : out;
}
