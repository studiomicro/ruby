/**
 * RB-20: where the standalone back control goes when there is no in-app page to go back to (an installed app has no
 * browser back button). Keyed by SvelteKit route id without the `(app)` group; the parent is a route id whose
 * parameters come from the current page. The four tab destinations (nav.ts `TAB_ITEMS`) have no entry: they show no
 * back control. route-parent.test.ts checks that every other `(app)` page has an entry and that every parent exists.
 */
export const ROUTE_PARENTS: Readonly<Record<string, string>> = {
	'/account': '/',
	'/admin': '/',
	'/admin/attachments': '/admin',
	'/admin/events': '/admin',
	'/admin/users': '/admin',
	'/calendar': '/',
	'/calendar/events/new': '/calendar',
	'/calendar/events/[id]': '/calendar',
	'/calendar/events/[id]/edit': '/calendar/events/[id]',
	'/hr/audit': '/people',
	'/kb/new': '/kb',
	'/kb/projects/[key]': '/kb',
	'/kb/[id]': '/kb',
	'/kb/[id]/delete': '/kb/[id]',
	'/kb/[id]/edit': '/kb/[id]',
	'/kb/[id]/history': '/kb/[id]',
	'/kb/[id]/history/[revision]': '/kb/[id]/history',
	'/kb/[id]/move': '/kb/[id]',
	'/notifications': '/',
	'/people': '/',
	'/people/new': '/people',
	'/people/org': '/people',
	'/people/[id]': '/people',
	'/people/[id]/edit': '/people/[id]',
	'/projects/new': '/projects',
	'/projects/[key]': '/projects',
	'/projects/[key]/milestones/[id]': '/projects/[key]',
	'/projects/[key]/settings': '/projects/[key]',
	'/projects/[key]/tasks/new': '/projects/[key]',
	'/projects/[key]/tasks/[number]': '/projects/[key]',
	'/releases': '/',
	'/reminders': '/',
	'/search': '/',
	'/time-off': '/',
	'/time-off/approvals': '/time-off',
	'/time-off/calendar': '/time-off',
	'/time-off/settings': '/time-off',
	'/time-off/team': '/time-off'
};

/** The parent page's path for a route id and its parameters, or null (a tab destination, or an unknown route). */
export function parentHref(
	routeId: string | null,
	params: Readonly<Record<string, string | undefined>>
): string | null {
	if (!routeId) return null;
	const parent = ROUTE_PARENTS[routeId.replace(/^\/\(app\)/, '') || '/'];
	if (!parent) return null;
	let missing = false;
	const href = parent.replace(/\[(\w+)\]/g, (_, name: string) => {
		const value = params[name];
		if (value === undefined) missing = true;
		return encodeURIComponent(value ?? '');
	});
	return missing ? null : href;
}
