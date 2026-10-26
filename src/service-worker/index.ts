/**
 * Ruby's service worker (RB-20): a read-only offline shell. It never stores a response at runtime.
 *
 * - install: downloads the build's files and the safe static files (manifest, icons, offline page, Geist) into one
 *   cache named after the build `version` (`shellPaths`, src/lib/shared/sw-policy.ts), refusing any redirected or
 *   non-200 answer. A first install then activates at once; an update (an older worker is active) waits until a page
 *   posts SKIP_WAITING (the update banner's Reload).
 * - activate: deletes every other cache and takes control of the open pages.
 * - fetch: shell files cache-first; page loads network-only, with the offline page only when the network request
 *   itself fails (a 401/403/5xx, a redirect or the Cloudflare Access login passes through untouched); everything else
 *   (`__data.json`, `/api/*`, `/files/*`, `/hr/*`, `/people/*`, non-GET, Range, cross-origin) is not intercepted.
 * - message: SKIP_WAITING lets a waiting update take over; SIGNED_OUT deletes every cache and downloads the shell again
 *   (sign-out also sends `Clear-Site-Data`, which Safari ignores). Both count only from a window of this origin.
 *
 * The only write to Cache Storage is `cache.put` in `precache()`, which stores the shell's static files and nothing
 * else (a source-scan test enforces it), so no runtime-cache code path exists to get wrong. Registered from bundled
 * code by src/lib/ui/pwa/register.svelte.ts
 * (never under `vite dev`), so the CSP needs no inline script.
 */
import { version } from '$app/env';
import { assets, immutable } from '$app/manifest';
import { self } from '$app/service-worker';
import {
	cacheName,
	isPrecacheable,
	isStaleCache,
	OFFLINE_PAGE,
	requestPolicy,
	shellPaths
} from '../lib/shared/sw-policy.ts';
import {
	isSignedOutMessage,
	isSkipWaitingMessage,
	isTrustedSender,
	skipWaitingOnInstall
} from '../lib/shared/sw-update.ts';

const CACHE = cacheName(version);
const SHELL = shellPaths(immutable, assets);
const SHELL_SET = new Set(SHELL);

/**
 * Downloads the shell into this build's cache: the one place this worker writes to Cache Storage. Each file is fetched
 * fresh with `redirect: 'error'` and stored only if it is a plain same-origin 200 (`isPrecacheable`), so a redirect
 * (an Access re-auth hop, a proxy) can never put another page's HTML under an asset path: the whole install fails
 * instead and the previous worker stays.
 */
async function precache(): Promise<void> {
	const cache = await caches.open(CACHE);
	await Promise.all(
		SHELL.map(async (path) => {
			const response = await fetch(path, { redirect: 'error', cache: 'reload' });
			if (!isPrecacheable(response))
				throw new Error(`precache: ${path} answered ${response.status}`);
			await cache.put(path, response);
		})
	);
}

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			await precache();
			if (skipWaitingOnInstall(self.registration.active !== null)) await self.skipWaiting();
		})()
	);
});

self.addEventListener('message', (event) => {
	if (!isTrustedSender(event.source, self.location.origin)) return;
	if (isSkipWaitingMessage(event.data)) event.waitUntil(self.skipWaiting());
	else if (isSignedOutMessage(event.data))
		event.waitUntil(
			(async () => {
				for (const key of await caches.keys()) await caches.delete(key);
				// Where the worker survives sign-out (Safari ignores Clear-Site-Data), download the shell again so the
				// offline page keeps working. It holds static files only; offline, it simply stays empty.
				await precache().catch(() => {});
			})()
		);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) if (isStaleCache(key, CACHE)) await caches.delete(key);
			await self.clients.claim();
		})()
	);
});

async function fromShell(request: Request): Promise<Response> {
	// Matched by path: shell files are requested without a query, except the offline page, whose query is ignored.
	const cached = await caches.match(new URL(request.url).pathname, {
		cacheName: CACHE,
		ignoreVary: true
	});
	return cached ?? fetch(request);
}

async function navigate(request: Request): Promise<Response> {
	try {
		return await fetch(request);
	} catch {
		const offline = await caches.match(OFFLINE_PAGE, { cacheName: CACHE });
		return offline ?? Response.error();
	}
}

self.addEventListener('fetch', (event) => {
	const policy = requestPolicy(event.request, self.location.origin, SHELL_SET);
	if (policy === 'shell') event.respondWith(fromShell(event.request));
	else if (policy === 'navigate') event.respondWith(navigate(event.request));
	// 'network': not intercepted, so the browser handles it and nothing is stored.
});
