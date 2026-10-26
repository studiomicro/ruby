/**
 * What the service worker (src/service-worker/index.ts) caches and how it answers each request (RB-20). Pure, so the
 * rules are unit-tested. A read-only offline shell: only the build's own files and safe static files are ever cached,
 * once, at install. Pages, `__data.json`, `/api/*`, downloads and HR routes always go to the network and are never
 * stored, so nothing of one signed-in person can be shown to the next person on a shared device. Anything this module
 * does not recognise is `network` (fail safe).
 */

/** The static page shown for a page load while the device is offline. */
export const OFFLINE_PAGE = '/offline.html';

/** Every cache this worker owns starts with this; the build version follows. */
export const CACHE_PREFIX = 'ruby-shell-';

/** The one cache of a build. */
export const cacheName = (version: string) => `${CACHE_PREFIX}${version}`;

/**
 * Whether an install-time answer may be stored under its shell path: a plain same-origin 200 that was not redirected.
 * Anything else (a redirect to the sign-in page, an Access login, an error page) fails the install.
 */
export function isPrecacheable(response: {
	ok: boolean;
	type: string;
	redirected: boolean;
}): boolean {
	return response.ok && response.type === 'basic' && !response.redirected;
}

/** True for every cache but the current one: deleted on activate (other versions and anything foreign). */
export const isStaleCache = (name: string, current: string) => name !== current;

/**
 * Fonts: only the file `app.html` preloads, Geist (about 70 KB), is precached, so the shell and the offline page keep
 * the typeface offline. Geist Mono, the licence texts and any later version stay with the browser's HTTP cache.
 */
export const SHELL_FONT = '/fonts/geist/1.7.2/Geist-Variable.woff2';
const isOtherFontPath = (path: string) => path.startsWith('/fonts/') && path !== SHELL_FONT;

/**
 * Static folders the browser or the OS asks for by itself (iOS launch images, the install dialog's screenshots):
 * large and only one per device, so they come from the network and are never downloaded by every visitor on install.
 */
const NETWORK_ONLY_DIRS = ['/splash/', '/screenshots/'] as const;

/**
 * Paths that may carry a person's data, or whose answer must always be fresh: never cached, never intercepted, also
 * not for a page load (a download link opened offline fails as the browser's own error, not as the offline page).
 */
const DATA_PREFIXES = ['/api/', '/files/', '/hr/', '/people/'] as const;
const DATA_EXACT = new Set(['/api', '/files', '/hr', '/people', '/logout', '/_app/version.json']);

/** True for a path that may carry a person's data or must never be stored. */
export function isDataPath(path: string): boolean {
	return (
		DATA_EXACT.has(path) ||
		path.endsWith('/__data.json') ||
		DATA_PREFIXES.some((prefix) => path.startsWith(prefix))
	);
}

/**
 * The absolute paths the service worker caches on install: the build's immutable files and the static folder
 * (`$app/manifest` `immutable` and `assets`, relative to the base path), minus any data path, the launch-image and
 * screenshot folders, every font but Geist and every HTML file but the offline page.
 */
export function shellPaths(
	immutable: readonly { path: string }[],
	assets: readonly { path: string }[]
): string[] {
	const paths = [...immutable, ...assets].map(({ path }) =>
		path.startsWith('/') ? path : `/${path}`
	);
	return [...new Set(paths)].filter(
		(p) =>
			!isDataPath(p) &&
			!isOtherFontPath(p) &&
			// No HTML but the offline page (a prerendered or static page is never kept).
			(!p.endsWith('.html') || p === OFFLINE_PAGE) &&
			!NETWORK_ONLY_DIRS.some((dir) => p.startsWith(dir))
	);
}

export type RequestPolicy =
	/** A cached shell file: cache first, network if missing. */
	| 'shell'
	/** A page load: network only; the offline page only when the network request itself fails. Never cached. */
	| 'navigate'
	/** Anything else: not intercepted, left to the browser, never cached. */
	| 'network';

export interface PolicyRequest {
	method: string;
	url: string;
	mode: string;
	headers: { has(name: string): boolean };
}

export function requestPolicy(
	request: PolicyRequest,
	origin: string,
	shell: ReadonlySet<string>
): RequestPolicy {
	if (request.method !== 'GET') return 'network';
	if (request.headers.has('range')) return 'network';
	const url = new URL(request.url);
	if (url.origin !== origin) return 'network';
	if (isDataPath(url.pathname)) return 'network';
	if (request.mode === 'navigate') return 'navigate';
	if (NETWORK_ONLY_DIRS.some((dir) => url.pathname.startsWith(dir))) return 'network';
	// Query strings are ignored for the offline page only; any other shell file with a query is someone else's URL.
	if ((url.search === '' || url.pathname === OFFLINE_PAGE) && shell.has(url.pathname))
		return 'shell';
	return 'network';
}
