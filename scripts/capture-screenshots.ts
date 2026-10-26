import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodeTruecolorPng } from './png.ts';
import { SEED_PASSWORD, SEED_USERS } from './seed-data.ts';

/**
 * RB-20: the screenshots in the web app manifest (`static/screenshots/`), for the richer install dialog of Chromium.
 * Run by hand against a LOCAL server whose D1 holds only the fictional seed data, then commit the outputs; never part
 * of `npm run gates`, `npm run build` or CI:
 *
 *   npm run build
 *   RUBY_PERSIST_TO=.wrangler/shots node scripts/reset-local.ts
 *   npx wrangler dev --persist-to .wrangler/shots --port 4531 --ip 127.0.0.1 --local-upstream localhost:4531
 *   node scripts/capture-screenshots.ts http://localhost:4531
 *
 * It signs in as the seeded admin (scripts/seed-data.ts) and photographs Home and the People directory on a phone
 * and Home on a desktop, in the light theme. No real data is ever on screen: the base URL must be this machine.
 *
 * Image rules (manifest screenshots): PNG, each side 320-3840 px, one aspect ratio per form factor.
 *   narrow: 1080x1920 (a 360x640 viewport at scale 3)
 *   wide:   1280x720
 */

export interface ShotSpec {
	/** Path under static/. */
	file: string;
	path: string;
	width: number;
	height: number;
	scale: number;
}

export const SHOTS: readonly ShotSpec[] = [
	{ file: 'screenshots/narrow-home.png', path: '/', width: 360, height: 640, scale: 3 },
	{ file: 'screenshots/narrow-people.png', path: '/people', width: 360, height: 640, scale: 3 },
	{ file: 'screenshots/wide-home.png', path: '/', width: 1280, height: 720, scale: 1 }
];

/** Only this machine: the screenshots must show the local fictional seed data, never a deployment's. */
export function assertLocalBaseUrl(raw: string | undefined): URL {
	if (!raw) throw new Error('Usage: node scripts/capture-screenshots.ts http://localhost:<port>');
	const url = new URL(raw);
	if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname))
		throw new Error(`Refusing: ${url.origin} is not this machine (http://localhost or 127.0.0.1).`);
	return url;
}

async function main(base: URL) {
	const { chromium } = await import('@playwright/test');
	const root = join(import.meta.dirname, '..');
	mkdirSync(join(root, 'static/screenshots'), { recursive: true });
	const browser = await chromium.launch();
	try {
		for (const shot of SHOTS) {
			const context = await browser.newContext({
				baseURL: base.origin,
				viewport: { width: shot.width, height: shot.height },
				deviceScaleFactor: shot.scale,
				isMobile: shot.width < 768,
				hasTouch: shot.width < 768,
				colorScheme: 'light',
				reducedMotion: 'reduce',
				locale: 'en-US',
				// No service worker: the screenshots show the server's pages, nothing from a cache.
				serviceWorkers: 'block'
			});
			const page = await context.newPage();
			await page.goto('/login');
			await page.getByLabel('E-mail').fill(SEED_USERS[0].email);
			await page.getByLabel('Password').fill(SEED_PASSWORD);
			await page.getByRole('button', { name: 'Sign in' }).click();
			await page.waitForURL(`${base.origin}/`);
			await page.goto(shot.path);
			await page.waitForLoadState('networkidle');
			await page.evaluate(() => document.fonts.ready);
			const png = encodeTruecolorPng(decodePng(await page.screenshot({ type: 'png' })), false);
			writeFileSync(join(root, 'static', shot.file), png);
			console.log(`wrote static/${shot.file} (${png.length} bytes)`);
			await context.close();
		}
	} finally {
		await browser.close();
	}
}

if (import.meta.main) await main(assertLocalBaseUrl(process.argv[2]));
