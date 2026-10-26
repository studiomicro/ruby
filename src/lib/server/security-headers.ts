/**
 * Headers set on every response, early refusals included. The CSP itself comes from SvelteKit (`csp` in
 * vite.config.ts). Ruby is an internal tool: no page is ever indexed, and it uses no camera, microphone or location.
 */
export function securityHeaders(): Record<string, string> {
	return {
		'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'strict-origin-when-cross-origin',
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
		'X-Robots-Tag': 'noindex'
	};
}
