/**
 * The one Content-Security-Policy. SvelteKit applies it to every rendered response (`csp` in vite.config.ts,
 * adding nonces or hashes for its own inline bootstrap). Never `'unsafe-inline'`: rendered Markdown is HTML from
 * #lib/shared/markdown with raw HTML disabled, and this policy is the second line behind it.
 */
import type { Config } from '@sveltejs/kit/vite';

type Directives = NonNullable<NonNullable<Config['csp']>['directives']>;

export const CSP_DIRECTIVES: Directives = {
	'default-src': ['self'],
	'script-src': ['self'],
	'style-src': ['self'],
	// SvelteKit's own route announcer carries one fixed inline style attribute; allow exactly that hash.
	'style-src-attr': ['unsafe-hashes', 'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo='],
	// Images from this origin only (attachments are served by the app): an image in a Markdown page never makes a
	// request to a third party.
	'img-src': ['self'],
	'font-src': ['self'],
	'connect-src': ['self'],
	// RB-20: the service worker (/service-worker.js) and the web app manifest come from this origin only. The manifest
	// would fall back to default-src anyway; stated so a change to default-src never moves it.
	'worker-src': ['self'],
	'manifest-src': ['self'],
	'object-src': ['none'],
	'base-uri': ['none'],
	'frame-ancestors': ['none'],
	'form-action': ['self']
};
