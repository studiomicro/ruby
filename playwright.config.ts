import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { e2eWorkers } from './scripts/machine-limits.ts';
import { STORAGE_STATE } from './e2e/helpers';

/**
 * Layout checks of the app shell in Chromium at phone and desktop sizes (`npm run test:e2e`; not part of `gates`).
 * The server is the production build under `wrangler dev` on localhost (no Cloudflare Access there: loopback hosts
 * skip it), with its own local D1 in `.wrangler/e2e-state`, reset, migrated and seeded with the fictional local
 * accounts (scripts/seed-data.ts) on every start. Nothing remote is touched.
 */
/** RUBY_E2E_PORT lets parallel worktrees each run their own server (reuseExistingServer would share one). */
const PORT = Number(process.env.RUBY_E2E_PORT ?? 4317);
const PERSIST = '.wrangler/e2e-state';
/**
 * A throwaway HR_DATA_KEY for the local server only (RB-05 field encryption); an inherited one is reused so a
 * reused server and this run agree. Never a production key.
 */
const HR_DATA_KEY = (process.env.RUBY_E2E_HR_DATA_KEY ??= randomBytes(32).toString('base64url'));
/** iOS Safari on an iPhone (the UA only steers nothing in Ruby; it makes the run look like the real device). */
const IPHONE_UA =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';
const iphone = (width: number, height: number) => ({
	browserName: 'chromium' as const,
	viewport: { width, height },
	deviceScaleFactor: 3,
	isMobile: true,
	hasTouch: true,
	userAgent: IPHONE_UA
});

export default defineConfig({
	testDir: 'e2e',
	outputDir: 'test-results',
	fullyParallel: true,
	// Bounded locally (scripts/machine-limits.ts); CI keeps Playwright's default.
	workers: process.env.CI ? undefined : e2eWorkers(),
	retries: 0,
	reporter: 'list',
	use: {
		baseURL: `http://localhost:${PORT}`,
		locale: 'en-US',
		reducedMotion: 'reduce',
		trace: 'retain-on-failure'
	},
	webServer: {
		command: [
			'npm run build',
			`RUBY_PERSIST_TO=${PERSIST} node scripts/reset-local.ts`,
			// --local-upstream: wrangler dev would otherwise present every request as the route host (the one in
			// wrangler.jsonc), a deployed host, so the app would demand HTTPS and Cloudflare Access.
			`npx wrangler dev --persist-to ${PERSIST} --port ${PORT} --ip 127.0.0.1 --inspector-port ${PORT + 1000} --local-upstream localhost:${PORT} --var HR_DATA_KEY:${HR_DATA_KEY}`
		].join(' && '),
		url: `http://localhost:${PORT}/login`,
		reuseExistingServer: !process.env.CI,
		timeout: 240_000
	},
	projects: [
		{ name: 'setup', testMatch: /auth\.setup\.ts/ },
		// iPhone 17, iPhone 17 Pro and iPhone 18 Pro: 402 × 874 CSS px at 3x.
		{
			name: 'iphone-402',
			use: { ...iphone(402, 874), storageState: STORAGE_STATE },
			dependencies: ['setup']
		},
		// iPhone Pro Max: 440 × 956.
		{
			name: 'iphone-440',
			use: { ...iphone(440, 956), storageState: STORAGE_STATE },
			dependencies: ['setup']
		},
		// The narrowest supported phone.
		{
			name: 'phone-360',
			use: { ...iphone(360, 780), storageState: STORAGE_STATE },
			dependencies: ['setup']
		},
		{
			name: 'desktop',
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 1280, height: 800 },
				storageState: STORAGE_STATE
			},
			dependencies: ['setup']
		}
	]
});
