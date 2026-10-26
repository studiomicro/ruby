import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { CSP_DIRECTIVES } from './src/lib/server/csp.ts';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			adapter: adapter({ platformProxy: { remoteBindings: false } }),
			// RB-20: src/lib/ui/pwa/register.svelte.ts registers the service worker itself (never under `vite dev`), so the
			// page can watch a waiting update and the update banner can let it take over.
			serviceWorker: { register: false },
			csp: { mode: 'auto', directives: CSP_DIRECTIVES },
			// Polls /_app/version.json every minute; `updated` (UpdateBanner) turns true when a new build is deployed.
			version: { pollInterval: 60_000 },
			// SvelteKit's form CSRF check is off ('*' is its documented switch,
			// https://svelte.dev/docs/kit/configuration#csrf) because it answers before any hook, without the security
			// headers. hooks.server.ts applies the same check first, to every request (src/lib/server/csrf.ts).
			csrf: { trustedOrigins: ['*'] }
		})
	]
});
