/**
 * Cross-site form protection, applied first in hooks.server.ts. SvelteKit's own check
 * (`csrf.trustedOrigins`, https://svelte.dev/docs/kit/configuration#csrf) runs before any hook, so its plain-text
 * 403 would leave without the security headers every other response carries. vite.config.ts therefore sets
 * `trustedOrigins: ['*']` (Kit's documented way to turn its check off) and this module applies the identical rule —
 * same methods, same form content types, same origin comparison, same answer — to every request. Ruby has no
 * Bearer-token API, so there is no exemption.
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** What an HTML form can send (Kit's list, `application/x-sveltekit-formdata` included). */
const FORM_TYPES = new Set([
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
	'application/x-sveltekit-formdata'
]);

/** SvelteKit's `is_csrf_forbidden` with no trusted origins: a cross-site (or Origin-less) form submission. */
export function isCrossSiteForm(request: Request, selfOrigin: string): boolean {
	const type = request.headers.get('content-type');
	const formType = (type?.split(';', 1)[0] ?? '').trim().toLowerCase();
	return (
		(!type || FORM_TYPES.has(formType)) &&
		MUTATING.has(request.method) &&
		request.headers.get('origin') !== selfOrigin
	);
}

/** SvelteKit's own refusal, unchanged: JSON for `Accept: application/json`, else plain text. */
export function crossSiteRefusal(request: Request): Response {
	const message = `Cross-site ${request.method} form submissions are forbidden`;
	return request.headers.get('accept') === 'application/json'
		? Response.json({ message }, { status: 403 })
		: new Response(message, {
				status: 403,
				headers: { 'content-type': 'text/plain;charset=UTF-8' }
			});
}
