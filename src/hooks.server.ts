import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { accessRefusal } from '#lib/server/auth/access';
import { authGate, isAuthRoute } from '#lib/server/auth/gate';
import { carriesInviteToken, redactedPath } from '#lib/server/auth/invites';
import { secureDeployment } from '#lib/server/auth/session';
import { crossSiteRefusal, isCrossSiteForm } from '#lib/server/csrf';
import { getDb } from '#lib/server/db';
import { getEnv } from '#lib/server/env';
import { securityHeaders } from '#lib/server/security-headers';
import { errorLabel, newId, now } from '#lib/server/util';

/** What sign-out clears in the browser (the session cookie is cleared by the action itself). */
const CLEAR_SITE_DATA = '"cache", "storage"';

/** Sets `cache-control` to `value` unless the response already chose its own. */
function cacheControl(response: Response, value: string): Response {
	if (!response.headers.has('cache-control')) response.headers.set('cache-control', value);
	return response;
}

function withSecurityHeaders(response: Response, url?: URL): Response {
	// An invite token in the URL is a bearer secret: a Referer carries at most the origin, never the path.
	// Not `no-referrer`: under it browsers send `Origin: null` on form POSTs, which the CSRF check refuses.
	if (url && carriesInviteToken(url)) response.headers.set('referrer-policy', 'strict-origin');
	for (const [name, value] of Object.entries(securityHeaders())) {
		if (!response.headers.has(name)) response.headers.set(name, value);
	}
	return response;
}

/**
 * The request pipeline, in this order: (1) cross-site form submissions are refused, exactly as SvelteKit would (its
 * own check is off in vite.config.ts; see lib/server/csrf.ts); (2) a deployed host is HTTPS only, so plain http is
 * sent to https before any cookie is read; (3) on a deployed host the Cloudflare Access JWT must verify (503 while
 * Access is not configured, 403 without a valid JWT; loopback hosts skip it); (4) the session cookie is resolved and
 * signed-out requests to `(app)` routes are answered; (5) the route runs. Every response, early ones included,
 * carries the security headers (`X-Robots-Tag: noindex` among them); early answers, error responses, sign-in pages
 * and signed-in pages are never cached (`no-store` unless the response set its own `cache-control`).
 */
const handleRequest: Handle = async ({ event, resolve }) => {
	if (isCrossSiteForm(event.request, event.url.origin))
		return withSecurityHeaders(cacheControl(crossSiteRefusal(event.request), 'no-store'));

	// Cookie name, Secure flag and the Access requirement follow the host, never the scheme.
	const secure = secureDeployment(event.url.hostname);
	event.locals.secure = secure;
	if (secure && event.url.protocol === 'http:') {
		const https = new URL(event.url);
		https.protocol = 'https:';
		https.port = '';
		return withSecurityHeaders(
			new Response(null, {
				status: 308,
				headers: { location: https.href, 'cache-control': 'no-store' }
			})
		);
	}

	const env = getEnv();
	// Owner decision 2026-10-26: Cloudflare Access can be switched off on purpose with ACCESS_DISABLED = "1" (exactly);
	// the in-app invite-only accounts then stand alone. Any other value keeps the fail-closed check.
	if (secure && env.ACCESS_DISABLED !== '1') {
		const refused = await accessRefusal(event.request, env, now());
		if (refused) return withSecurityHeaders(cacheControl(refused, 'no-store'), event.url);
	}

	event.locals.db = getDb(env.DB);
	const early = await authGate(event, event.locals.db, secure, now());
	if (early) return withSecurityHeaders(cacheControl(early, 'no-store'), event.url);

	const response = await resolve(event);
	// Signed-in pages carry the team's internal work, the sign-in pages carry an invitee's address (and an invite
	// URL is a bearer token), and an error page is never worth keeping: none is stored by shared caches or the
	// back/forward cache.
	if (event.locals.user || isAuthRoute(event.route.id) || response.status >= 400)
		cacheControl(response, 'private, no-store');
	if (event.locals.clearSiteData) response.headers.set('clear-site-data', CLEAR_SITE_DATA);
	return withSecurityHeaders(response, event.url);
};

/**
 * One log line per request: method, the route id (never its parameters) or, when no route matched, the path with any
 * invite token masked (`redactedPath`), status and duration. Never the query string, headers or body. Workers Logs'
 * own invocation logs carry the full URL, invite tokens included, so they are switched off in wrangler.jsonc
 * (`observability.logs.invocation_logs: false`) and this line takes their place.
 */
export const handle: Handle = async (input) => {
	const started = Date.now();
	const response = await handleRequest(input);
	const { event } = input;
	console.log('request', {
		method: event.request.method,
		path: event.route.id ?? redactedPath(event.url),
		status: response.status,
		ms: Date.now() - started
	});
	return response;
};

/**
 * Unexpected errors: one log line with an id, the route and `errorLabel` only — never the error message, stack or
 * request body, which can hold bound query values and so user data. The error page shows the id so a user can quote
 * it. App and framework errors (404, 403 …) are not logged.
 */
export const handleError: HandleServerError = ({ kind, error, event }) => {
	if (kind !== 'unknown') return;
	const id = newId().slice(0, 8);
	console.error('unhandled error', id, event.route.id ?? '-', errorLabel(error));
	return { message: 'Something went wrong.', id };
};
