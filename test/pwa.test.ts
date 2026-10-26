import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng, pngChunks, pngHeader } from '../scripts/png';
import { SPLASH_BUDGET_BYTES } from '../scripts/generate-splash-screens';
import { CSP_DIRECTIVES } from '../src/lib/server/csp';
import { splashMedia, SPLASH_LINKS } from '../src/lib/shared/splash';
import { SPLASH_SCREENS } from '../src/lib/shared/splash-screens';
import { OFFLINE_PAGE, shellPaths } from '../src/lib/shared/sw-policy';

/**
 * RB-20: the installable app's static side (manifest, icons, launch images, head tags, static headers, CSP) and the
 * source rules that keep the service worker a read-only shell.
 */

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}
const staticPath = (src: string) => join('static', src.replace(/^\//, ''));

interface Manifest {
	name: string;
	short_name: string;
	id: string;
	start_url: string;
	scope: string;
	display: string;
	orientation: string;
	background_color: string;
	theme_color: string;
	icons: { src: string; sizes: string; type: string; purpose: string }[];
	shortcuts: { name: string; url: string; icons: { src: string; sizes: string }[] }[];
	screenshots: { src: string; sizes: string; form_factor: string }[];
}
const manifest = JSON.parse(readFileSync('static/manifest.webmanifest', 'utf8')) as Manifest;

/** Every `(app)` and `(auth)` page path, from the route tree. */
function pagePaths(dir = 'src/routes', prefix = ''): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (!statSync(path).isDirectory()) {
			if (name === '+page.svelte') out.push(prefix || '/');
			continue;
		}
		out.push(...pagePaths(path, /^\(.*\)$/.test(name) ? prefix : `${prefix}/${name}`));
	}
	return out;
}

describe('web app manifest (AC1, AC2)', () => {
	it('names Ruby, opens standalone at / and takes any orientation', () => {
		expect(manifest).toMatchObject({
			name: 'Ruby',
			short_name: 'Ruby',
			id: '/',
			start_url: '/',
			scope: '/',
			display: 'standalone',
			orientation: 'any',
			background_color: '#fbfbfb',
			theme_color: '#fbfbfb'
		});
	});

	it('has the five PNG icons, each file the size it states', () => {
		const pngs = manifest.icons.filter((i) => i.type === 'image/png');
		expect(pngs.map((i) => `${i.sizes} ${i.purpose}`)).toEqual([
			'192x192 any',
			'512x512 any',
			'192x192 maskable',
			'512x512 maskable',
			'512x512 monochrome'
		]);
		const all = [
			...manifest.icons.filter((i) => i.type === 'image/png'),
			...manifest.shortcuts.flatMap((s) => s.icons),
			...manifest.screenshots
		];
		for (const { src, sizes } of all) {
			const { width, height } = pngHeader(readFileSync(staticPath(src)));
			expect(`${width}x${height}`, src).toBe(sizes);
		}
		expect(existsSync('static/icons/icon.svg')).toBe(true);
	});

	it('at most four shortcuts, each an existing page inside the scope; no issue shortcut without that route', () => {
		const pages = new Set(pagePaths());
		expect(manifest.shortcuts.length).toBeLessThanOrEqual(4);
		for (const { url } of manifest.shortcuts) {
			expect(url.startsWith(manifest.scope), url).toBe(true);
			expect(pages.has(new URL(url, 'https://x.test').pathname), url).toBe(true);
		}
		if (!pages.has('/issues/new'))
			expect(manifest.shortcuts.map((s) => s.url)).not.toContain('/issues/new');
	});

	it('two narrow and one wide screenshot', () => {
		expect(manifest.screenshots.map((s) => s.form_factor)).toEqual(['narrow', 'narrow', 'wide']);
	});
});

describe('icons (AC4)', () => {
	it('apple-touch-icon is 180x180 RGB with no alpha at all', () => {
		const buf = readFileSync('static/icons/apple-touch-icon.png');
		expect(pngHeader(buf)).toMatchObject({ width: 180, height: 180, colorType: 2 });
		expect(pngChunks(buf)).not.toContain('tRNS');
	});

	it('maskable icons are full-bleed ruby red with the white gem inside the 80 % safe circle', () => {
		for (const size of [192, 512]) {
			const { width, data } = decodePng(readFileSync(`static/icons/icon-maskable-${size}.png`));
			const at = (x: number, y: number) => {
				const i = (y * width + x) * 4;
				return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
			};
			for (const [x, y] of [
				[0, 0],
				[size - 1, 0],
				[0, size - 1],
				[size - 1, size - 1]
			] as const)
				expect(at(x, y), `corner ${x},${y}`).toEqual([0xb4, 0x23, 0x3c, 255]);
			// The centre is the gem (white), and nothing white lies outside the safe circle.
			expect(at(size / 2, size / 2)[0]).toBeGreaterThan(230);
			const r = size * 0.4;
			for (let y = 0; y < size; y += 4)
				for (let x = 0; x < size; x += 4)
					if (Math.hypot(x - size / 2, y - size / 2) > r)
						expect(at(x, y), `${x},${y}`).toEqual([0xb4, 0x23, 0x3c, 255]);
		}
	});

	it('the monochrome icon is transparent around the gem', () => {
		const { data } = decodePng(readFileSync('static/icons/icon-monochrome-512.png'));
		expect(data[3]).toBe(0);
		const centre = (256 * 512 + 256) * 4;
		expect(data[centre + 3]).toBe(255);
	});
});

describe('iOS launch images (AC5)', () => {
	it('include iPhone 17 / 17 Pro / 18 Pro (402x874 @3) and Pro Max (440x956 @3)', () => {
		const sizes = SPLASH_SCREENS.map((s) => `${s.width}x${s.height}@${s.scale}`);
		expect(sizes).toContain('402x874@3');
		expect(sizes).toContain('440x956@3');
		expect(SPLASH_SCREENS.find((s) => s.width === 402)?.light).toBe(
			'/splash/splash-1206x2622-light.png'
		);
		expect(SPLASH_SCREENS.find((s) => s.width === 440)?.dark).toBe(
			'/splash/splash-1320x2868-dark.png'
		);
	});

	it('every link points at an existing, non-empty indexed PNG of the device pixel size', () => {
		expect(SPLASH_LINKS).toHaveLength(SPLASH_SCREENS.length * 2);
		let total = 0;
		for (const screen of SPLASH_SCREENS)
			for (const scheme of ['light', 'dark'] as const) {
				const buf = readFileSync(staticPath(screen[scheme]));
				total += buf.length;
				expect(pngHeader(buf), screen[scheme]).toMatchObject({
					width: screen.width * screen.scale,
					height: screen.height * screen.scale,
					colorType: 3
				});
				expect(SPLASH_LINKS).toContainEqual({
					href: screen[scheme],
					media: splashMedia(screen, scheme)
				});
				expect(splashMedia(screen, scheme)).toContain(`(prefers-color-scheme: ${scheme})`);
			}
		expect(total).toBeLessThanOrEqual(SPLASH_BUDGET_BYTES);
		// No file without a link.
		expect(readdirSync('static/splash')).toHaveLength(SPLASH_LINKS.length);
	});
});

describe('head tags (AC3)', () => {
	const html = readFileSync('src/app.html', 'utf8');
	it('links the manifest with credentials, the touch icon and the status-bar style', () => {
		const manifest = html.match(/<link\s+rel="manifest"[^>]*>/)?.[0] ?? '';
		expect(manifest).toMatch(/href="%sveltekit\.assets%\/manifest\.webmanifest"/);
		expect(manifest).toMatch(/crossorigin="use-credentials"/);
		expect(html).toContain(
			'<link rel="apple-touch-icon" href="%sveltekit.assets%/icons/apple-touch-icon.png" />'
		);
		expect(html).toContain(
			'<meta name="apple-mobile-web-app-status-bar-style" content="default" />'
		);
		expect(html).toContain('<meta name="mobile-web-app-capable" content="yes" />');
		expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Ruby" />');
	});
	it('keeps both theme-color metas and never blocks zoom', () => {
		expect(html).toContain(
			'<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fbfbfb" />'
		);
		expect(html).toContain(
			'<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#030303" />'
		);
		const viewport = html.match(/<meta name="viewport" content="([^"]*)"/)?.[1] ?? '';
		expect(viewport).toContain('width=device-width');
		expect(viewport).not.toMatch(/maximum-scale|user-scalable/);
		expect(html).not.toMatch(/<script/);
	});
});

describe('static headers (_headers, AC14)', () => {
	const headers = readFileSync('_headers', 'utf8');
	const rule = (path: string) => {
		const match = headers.match(
			new RegExp(`^${path.replace(/[.*]/g, '\\$&')}\\n((?:  .*\\n?)+)`, 'm')
		);
		return match?.[1] ?? '';
	};
	it('the version poll stays no-store; the worker and the manifest are revalidated', () => {
		expect(rule('/_app/version.json')).toContain('Cache-Control: no-store');
		expect(rule('/service-worker.js')).toContain('Cache-Control: no-cache');
		expect(rule('/manifest.webmanifest')).toContain('Content-Type: application/manifest+json');
	});
	it('the offline page allows no script and is never framed', () => {
		const offline = rule('/offline.html');
		expect(offline).toContain("script-src 'none'");
		expect(offline).toContain("frame-ancestors 'none'");
		expect(offline).not.toContain('unsafe-inline');
	});
});

describe('CSP (AC16)', () => {
	it("worker and manifest from this origin only; never 'unsafe-inline' for scripts", () => {
		expect(CSP_DIRECTIVES['worker-src']).toEqual(['self']);
		expect(CSP_DIRECTIVES['manifest-src']).toEqual(['self']);
		expect(CSP_DIRECTIVES['script-src']).toEqual(['self']);
		expect(JSON.stringify(CSP_DIRECTIVES)).not.toContain('unsafe-inline');
	});
});

describe('offline page', () => {
	const html = readFileSync('static/offline.html', 'utf8');
	it('is generic English with no script and no inline style; Try again goes to /', () => {
		expect(html).toContain('<title>Offline · Ruby</title>');
		expect(html).toContain('You are offline');
		expect(html).toContain('<a class="retry" href="/">Try again</a>');
		expect(html).not.toMatch(/<script|style=|<style/i);
	});
	it('offline.css is the one file outside src/ that reads env(safe-area-inset-*) (AC26)', () => {
		expect(readFileSync('static/offline.css', 'utf8')).toContain('env(safe-area-inset-bottom');
	});
});

describe('shell cache (AC25)', () => {
	it('precaches at most 3 MB of static files, no launch image, screenshot or non-Geist font', () => {
		const assets = files('static').map((path) => ({ path: path.replace(/^static\//, '') }));
		const shell = shellPaths([], assets);
		expect(shell).toContain(OFFLINE_PAGE);
		expect(shell.filter((p) => /^\/(splash|screenshots)\//.test(p))).toEqual([]);
		expect(shell.filter((p) => p.startsWith('/fonts/'))).toEqual([
			'/fonts/geist/1.7.2/Geist-Variable.woff2'
		]);
		const bytes = shell.reduce((sum, p) => sum + statSync(staticPath(p)).size, 0);
		expect(bytes).toBeLessThan(3_000_000);
	});
});

describe('source rules', () => {
	const sw = readFileSync('src/service-worker/index.ts', 'utf8');

	it('the service worker writes to Cache Storage only in precache(), which refuses redirects', () => {
		const code = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
		const writes = [...code.matchAll(/\.(put|add|addAll)\(/g)];
		expect(writes.map((m) => m[0])).toEqual(['.put(']);
		const precache = code.slice(
			code.indexOf('async function precache'),
			code.indexOf("addEventListener('install'")
		);
		expect(precache).toContain('cache.put(path, response)');
		expect(precache).toContain("redirect: 'error'");
		expect(precache).toContain('isPrecacheable(response)');
		// Called at install, and again after the sign-out wipe; never from fetch.
		const fetchHandler = code.slice(code.indexOf("addEventListener('fetch'"));
		expect(fetchHandler).not.toContain('precache(');
		expect(code).not.toMatch(/navigationPreload|addEventListener\('push'/);
	});

	it('no page or component asks for notification permission (push is off)', () => {
		for (const file of files('src'))
			expect(readFileSync(file, 'utf8'), file).not.toContain('requestPermission');
	});

	it('every form uses the offline-aware enhance, never $app/forms directly', () => {
		const offenders = files('src')
			.filter((f) => /\.(svelte|ts)$/.test(f) && !f.endsWith('.test.ts'))
			.filter((f) => !f.endsWith(join('pwa', 'offline-form.ts')))
			.filter((f) =>
				/import\s*\{[^}]*\benhance\b[^}]*\}\s*from\s*'\$app\/forms'/.test(readFileSync(f, 'utf8'))
			);
		expect(offenders).toEqual([]);
	});

	it('the root layout registers nothing inline; SvelteKit does not register the worker itself', () => {
		expect(readFileSync('vite.config.ts', 'utf8')).toContain('serviceWorker: { register: false }');
		const register = readFileSync('src/lib/ui/pwa/register.svelte.ts', 'utf8');
		expect(register).toContain("register('/service-worker.js'");
	});
});
