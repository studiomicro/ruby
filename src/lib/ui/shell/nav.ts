import type { IconName } from '#lib/ui/kit/Icon.svelte';

/**
 * The app's navigation, in one place (owner request 2026-10-26: "clean up the sidebar"). The shell
 * (`(app)/+layout.svelte`) renders it as grouped sidebar sections on wide screens and as the tab bar plus the More
 * sheet on phones. A feature adds its destination here, in the section it belongs to, and nowhere else.
 */
export interface NavItem {
	href: string;
	label: string;
	icon: IconName;
	/** The tab bar's shorter label. */
	short?: string;
	/** Shown to admins only (display only: the route itself checks the role). */
	adminOnly?: boolean;
}

export interface NavSection {
	/** A small heading above the group; the first group has none. */
	label?: string;
	items: NavItem[];
}

const HOME: NavItem = { href: '/', label: 'Home', icon: 'home' };
const MY_TASKS: NavItem = { href: '/my-tasks', label: 'My tasks', icon: 'tasks' };
const PROJECTS: NavItem = { href: '/projects', label: 'Projects', icon: 'projects' };
const KB: NavItem = { href: '/kb', label: 'Knowledge base', short: 'KB', icon: 'book' };
const PEOPLE: NavItem = { href: '/people', label: 'People', icon: 'people' };
const TIME_OFF: NavItem = { href: '/time-off', label: 'Time off', icon: 'calendar' };
/** RB-09; `/reminders` is reached from the calendar page and from Account, not from the nav. */
const CALENDAR: NavItem = { href: '/calendar', label: 'Calendar', icon: 'calendar' };

/** The sidebar's groups: daily work first, then the team. */
export const NAV_SECTIONS: NavSection[] = [
	{ items: [HOME, MY_TASKS, PROJECTS, CALENDAR, KB] },
	{ label: 'Team', items: [PEOPLE, TIME_OFF] }
];

/** The four destinations of the phone tab bar, in order; the rest live under "More". */
export const TAB_ITEMS: NavItem[] = [HOME, MY_TASKS, PROJECTS, KB];

/** Icon buttons next to the brand (sidebar) and in the phone top bar. */
export const SEARCH: NavItem = { href: '/search', label: 'Search', icon: 'search' };
export const NOTIFICATIONS: NavItem = {
	href: '/notifications',
	label: 'Notifications',
	icon: 'bell'
};

/** Secondary links above the account row (sidebar) and at the end of the More sheet. */
export const FOOTER_ITEMS: NavItem[] = [
	{ href: '/releases', label: "What's new", icon: 'sparkle' },
	{ href: '/admin', label: 'Admin', icon: 'shield', adminOnly: true }
];

export const ACCOUNT: NavItem = { href: '/account', label: 'Account', icon: 'user' };

/**
 * RB-20: app actions, buttons rather than destinations: "Install Ruby" (src/lib/ui/pwa/InstallEntry.svelte) and
 * "Refresh" (RefreshAction.svelte). The More sheet lists them above "What's new"; the Account page's "App" section
 * shows the same two.
 */
export interface AppAction {
	id: 'install' | 'refresh';
	label: string;
	icon: IconName;
}

export const APP_ACTIONS: AppAction[] = [
	{ id: 'install', label: 'Install Ruby', icon: 'download' },
	{ id: 'refresh', label: 'Refresh', icon: 'refresh' }
];

export const visibleTo = (isAdmin: boolean) => (item: NavItem) => !item.adminOnly || isAdmin;

/** What the phone More sheet lists: every destination the tab bar does not show, in sidebar order. */
export function moreItems(isAdmin: boolean): NavItem[] {
	const inTabs = new Set(TAB_ITEMS.map((item) => item.href));
	return [
		...NAV_SECTIONS.flatMap((section) => section.items).filter((item) => !inTabs.has(item.href)),
		SEARCH,
		NOTIFICATIONS,
		...FOOTER_ITEMS,
		ACCOUNT
	].filter(visibleTo(isAdmin));
}

export type SheetEntry = { kind: 'link'; item: NavItem } | { kind: 'action'; action: AppAction };

/** The More sheet in order: `moreItems`, with the app actions right before the first footer link ("What's new"). */
export function moreSheetEntries(isAdmin: boolean): SheetEntry[] {
	const items = moreItems(isAdmin);
	const footer = new Set(FOOTER_ITEMS.map((item) => item.href));
	let at = items.findIndex((item) => footer.has(item.href));
	if (at < 0) at = items.length;
	return [
		...items.slice(0, at).map((item) => ({ kind: 'link' as const, item })),
		...APP_ACTIONS.map((action) => ({ kind: 'action' as const, action })),
		...items.slice(at).map((item) => ({ kind: 'link' as const, item }))
	];
}
