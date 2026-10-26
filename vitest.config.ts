import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	// Compiles .svelte files for server-render tests (svelte/server); there is no browser environment.
	plugins: [svelte()],
	// Vitest has no SvelteKit plugin: `$app/env` comes from a stub.
	resolve: {
		alias: { '$app/env': fileURLToPath(new URL('./test/helpers/app-env.ts', import.meta.url)) }
	},
	test: {
		include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'test/**/*.test.ts'],
		environment: 'node',
		testTimeout: 30_000,
		// openLocalD1 (workerd start + every migration) in beforeAll can pass the 10 s default under parallel load.
		hookTimeout: 60_000
	}
});
