import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodeTruecolorPng } from './png.ts';

/**
 * RB-20: the home-screen and manifest icons, drawn from Ruby's mark in `static/favicon.svg` (the ruby-red tile with
 * the white gem). Run by hand when the mark changes, then commit the outputs; never part of `npm run gates`,
 * `npm run build` or CI:
 *
 *   node scripts/generate-icons.ts
 *
 * Each PNG is a screenshot of an SVG in Playwright's Chromium (the `@playwright/test` devDependency, its browser
 * installed), re-encoded by `scripts/png.ts`: no image dependency, no metadata, the same input gives the same bytes on
 * the same Chromium.
 *
 * - `any` (192, 512): the favicon as it is, a rounded tile on transparency.
 * - `maskable` (192, 512) and `apple-touch-icon.png` (180): `#b4233c` to every edge, the gem at the favicon's own
 *   scale. The gem's farthest point lies 10 of 32 units from the centre, inside the 12.8-unit safe circle (the
 *   centre 80 %), so a launcher's crop never cuts it. Opaque RGB: iOS paints transparency black and rounds the corners
 *   itself.
 * - `monochrome` (512): the gem alone, white on transparency (launchers use its alpha only).
 * - `shortcut-*.png` (96): the app's own nav glyph (src/lib/ui/kit/Icon.svelte) in white on the rounded tile.
 * - `icon.svg`: the favicon, for browsers that take an SVG icon.
 */

const ROOT = join(import.meta.dirname, '..');
const RUBY = '#b4233c';

const FAVICON = readFileSync(join(ROOT, 'static/favicon.svg'), 'utf8');
/** The gem: every <path> of the favicon. */
const GEM_PATHS = [...FAVICON.matchAll(/<path d="([^"]+)"[^>]*\/>/g)].map((m) => m[1]!);
if (GEM_PATHS.length === 0) throw new Error('static/favicon.svg: no gem paths found');

/** A nav glyph's path data, read from Icon.svelte so the shortcut icons match the app's own icons. */
function glyph(name: string): string {
	const source = readFileSync(join(ROOT, 'src/lib/ui/kit/Icon.svelte'), 'utf8');
	const match = source.match(new RegExp(`\\b${name}:\\s*'([^']+)'`));
	if (!match) throw new Error(`Icon.svelte: no glyph "${name}"`);
	return match[1]!;
}

export interface IconFile {
	/** Path under static/. */
	file: string;
	size: number;
	/** Opaque files are written as RGB without any alpha channel. */
	opaque: boolean;
	svg: () => string;
}

const svgOpen = (size: number, viewBox: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">`;

const tileAny = (size: number) =>
	FAVICON.replace('<svg ', `<svg width="${size}" height="${size}" `);

const fullBleed = (size: number) =>
	`${svgOpen(size, '0 0 32 32')}<rect width="32" height="32" fill="${RUBY}"/>` +
	`${GEM_PATHS.map((d, i) => `<path d="${d}" fill="#fff" opacity="${i === 0 ? '.92' : '.7'}"/>`).join('')}</svg>`;

const monochrome = (size: number) =>
	`${svgOpen(size, '0 0 32 32')}${GEM_PATHS.map((d) => `<path d="${d}" fill="#fff"/>`).join('')}</svg>`;

/** The glyph's 24-unit grid scaled to 60 % of the tile, centred. */
const shortcut = (size: number, name: string) =>
	`${svgOpen(size, '0 0 32 32')}<rect width="32" height="32" rx="8" fill="${RUBY}"/>` +
	`<g transform="translate(8.8 8.8) scale(0.6)" fill="none" stroke="#fff" stroke-width="2.25" ` +
	`stroke-linecap="round" stroke-linejoin="round"><path d="${glyph(name)}"/></g></svg>`;

export const ICON_FILES: readonly IconFile[] = [
	{ file: 'icons/icon-192.png', size: 192, opaque: false, svg: () => tileAny(192) },
	{ file: 'icons/icon-512.png', size: 512, opaque: false, svg: () => tileAny(512) },
	{ file: 'icons/icon-maskable-192.png', size: 192, opaque: true, svg: () => fullBleed(192) },
	{ file: 'icons/icon-maskable-512.png', size: 512, opaque: true, svg: () => fullBleed(512) },
	{ file: 'icons/icon-monochrome-512.png', size: 512, opaque: false, svg: () => monochrome(512) },
	{ file: 'icons/apple-touch-icon.png', size: 180, opaque: true, svg: () => fullBleed(180) },
	{
		file: 'icons/shortcut-projects.png',
		size: 96,
		opaque: false,
		svg: () => shortcut(96, 'projects')
	},
	{ file: 'icons/shortcut-tasks.png', size: 96, opaque: false, svg: () => shortcut(96, 'tasks') },
	{ file: 'icons/shortcut-search.png', size: 96, opaque: false, svg: () => shortcut(96, 'search') }
];

async function main() {
	const { chromium } = await import('@playwright/test');
	mkdirSync(join(ROOT, 'static/icons'), { recursive: true });
	writeFileSync(join(ROOT, 'static/icons/icon.svg'), FAVICON);
	console.log('wrote static/icons/icon.svg');
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ deviceScaleFactor: 1 });
		for (const icon of ICON_FILES) {
			await page.setViewportSize({ width: icon.size, height: icon.size });
			await page.setContent(
				`<!doctype html><html><body style="margin:0;background:transparent">${icon.svg()}</body></html>`
			);
			const shot = await page.screenshot({
				type: 'png',
				omitBackground: true,
				clip: { x: 0, y: 0, width: icon.size, height: icon.size }
			});
			const png = encodeTruecolorPng(decodePng(shot), !icon.opaque);
			writeFileSync(join(ROOT, 'static', icon.file), png);
			console.log(`wrote static/${icon.file} (${png.length} bytes)`);
		}
	} finally {
		await browser.close();
	}
}

if (import.meta.main) await main();
