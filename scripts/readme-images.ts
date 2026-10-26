import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { chromium } from '@playwright/test';

/**
 * Renders the README images (`npm run readme:images`). Each image is an HTML template in docs/readme/src/ that is
 * drawn with Ruby's own design tokens and fonts and composes the screenshots in docs/readme/src/shots/ (taken by
 * e2e/screenshots.spec.ts) into browser and phone frames. Output: docs/readme/<name>.png at 2× density. Local only:
 * it opens files from disk in a headless Chromium and makes no network request.
 *
 * Template conventions, expanded here before the screenshot:
 * - `<body data-width data-height>` is the image size in CSS px.
 * - `.light` / `.dark` get the light and dark token blocks of src/app.css.
 * - `<div class="browser" data-shot data-url>` becomes a browser window around the screenshot.
 * - `<div class="phone" data-shot>` becomes an iPhone with a Dynamic Island around the screenshot.
 * - `<svg class="mark">` becomes Ruby's mark (static/favicon.svg) in `--logo`.
 */

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'docs/readme/src');
const OUT = join(ROOT, 'docs/readme');
const IMAGES = [
	'banner',
	'features',
	'tour-board',
	'tour-kb',
	'tour-people',
	'tour-phone',
	'architecture'
];
/** GitHub shows the README images at up to about 1000 px; 2× keeps them sharp, and each stays small to load. */
const SCALE = 2;
const MAX_BYTES = 600 * 1024;

/** The declarations of the first rule whose selector is exactly `selector` (a top-level rule of app.css). */
function declarations(css: string, selector: string): string {
	const start = css.indexOf(`\n${selector} {`);
	if (start < 0) throw new Error(`src/app.css has no rule ${selector}`);
	const open = css.indexOf('{', start);
	const close = css.indexOf('\n}', open);
	return css.slice(open + 1, close);
}

const appCss = readFileSync(join(ROOT, 'src/app.css'), 'utf8');
const tokens = [
	`.light {${declarations(appCss, ':root')}}`,
	`.dark {${declarations(appCss, ":root[data-theme='dark']")}}`
].join('\n');
const mark = readFileSync(join(ROOT, 'static/favicon.svg'), 'utf8').replace(
	'fill="#b4233c"',
	'fill="currentColor"'
);

/** Expands the frames and marks of a template (runs in the page). */
function expand(markSvg: string) {
	const statusIcons =
		'<svg viewBox="0 0 64 13" aria-hidden="true"><rect x="0" y="8" width="3.5" height="5" rx="1"/>' +
		'<rect x="5" y="5.5" width="3.5" height="7.5" rx="1"/><rect x="10" y="3" width="3.5" height="10" rx="1"/>' +
		'<rect x="15" y="0" width="3.5" height="13" rx="1"/>' +
		'<path d="M30 3.2a10 10 0 0 1 13 0l-1.4 1.5a8 8 0 0 0-10.2 0zM32.4 5.9a6.4 6.4 0 0 1 8.2 0l-1.4 1.5a4.4 4.4 0 0 0-5.4 0zM36.5 12l-2.3-2.4a3.4 3.4 0 0 1 4.6 0z"/>' +
		'<rect x="47" y="1" width="14.5" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".5"/>' +
		'<rect x="49" y="3" width="10.5" height="7" rx="1.6"/><rect x="62.4" y="4.6" width="1.4" height="3.8" rx=".7" opacity=".5"/></svg>';
	for (const el of document.querySelectorAll<HTMLElement>('.browser[data-shot]')) {
		el.innerHTML =
			`<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>` +
			`<span class="url">${el.dataset.url ?? 'ruby.example.com'}</span></div>` +
			`<img class="screen" alt="" src="${el.dataset.shot}">`;
	}
	for (const el of document.querySelectorAll<HTMLElement>('.phone[data-shot]')) {
		el.innerHTML =
			`<div class="glass"><img alt="" src="${el.dataset.shot}"><div class="island"></div>` +
			`<div class="status"><span>9:41</span>${statusIcons}</div><div class="home"></div></div>`;
	}
	for (const el of document.querySelectorAll('svg.mark')) {
		const size = el.getAttribute('width') ?? '32';
		const holder = document.createElement('span');
		holder.innerHTML = markSvg;
		const svg = holder.firstElementChild!;
		svg.setAttribute('class', 'mark');
		svg.setAttribute('width', size);
		svg.setAttribute('height', size);
		svg.setAttribute('style', 'color: var(--logo)');
		el.replaceWith(svg);
	}
}

const paeth = (a: number, b: number, c: number) => {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Re-encodes an 8-bit RGB or RGBA PNG losslessly with the best row filter and the strongest deflate level (Chromium
 * favours speed): the same pixels in fewer bytes. Other chunks (gamma, text) are dropped.
 */
function smallerPng(png: Buffer): Buffer {
	const width = png.readUInt32BE(16);
	const height = png.readUInt32BE(20);
	const [depth, type, , , interlace] = png.subarray(24, 29);
	const bpp = type === 2 ? 3 : type === 6 ? 4 : 0;
	if (depth !== 8 || bpp === 0 || interlace !== 0) return png;
	const idat: Buffer[] = [];
	for (let at = 8; at < png.length;) {
		const length = png.readUInt32BE(at);
		if (png.toString('latin1', at + 4, at + 8) === 'IDAT')
			idat.push(png.subarray(at + 8, at + 8 + length));
		at += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * bpp;
	const pixels = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!;
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const row = y * stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= bpp ? pixels[row + x - bpp]! : 0;
			const b = y > 0 ? pixels[row - stride + x]! : 0;
			const c = x >= bpp && y > 0 ? pixels[row - stride + x - bpp]! : 0;
			const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]!;
			pixels[row + x] = (line[x]! + predictor) & 0xff;
		}
	}
	const filtered = Buffer.alloc(height * (stride + 1));
	const candidate = Buffer.alloc(stride);
	for (let y = 0; y < height; y++) {
		const row = y * stride;
		let bestScore = Infinity;
		for (let filter = 0; filter < 5; filter++) {
			let score = 0;
			for (let x = 0; x < stride; x++) {
				const a = x >= bpp ? pixels[row + x - bpp]! : 0;
				const b = y > 0 ? pixels[row - stride + x]! : 0;
				const c = x >= bpp && y > 0 ? pixels[row - stride + x - bpp]! : 0;
				const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]!;
				const value = (pixels[row + x]! - predictor) & 0xff;
				candidate[x] = value;
				score += value < 128 ? value : 256 - value;
			}
			if (score < bestScore) {
				bestScore = score;
				filtered[y * (stride + 1)] = filter;
				candidate.copy(filtered, y * (stride + 1) + 1);
			}
		}
	}
	const chunk = (name: string, data: Buffer) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length, 0);
		head.write(name, 4, 'latin1');
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
		return Buffer.concat([head, data, crc]);
	};
	const out = Buffer.concat([
		png.subarray(0, 8),
		chunk('IHDR', png.subarray(16, 29)),
		chunk('IDAT', deflateSync(filtered, { level: 9, memLevel: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
	return out.length < png.length ? out : png;
}

const only = process.argv.slice(2);
const browser = await chromium.launch();
let failed = false;
try {
	for (const name of IMAGES.filter((n) => only.length === 0 || only.includes(n))) {
		const file = join(SRC, `${name}.html`);
		const page = await browser.newPage({ deviceScaleFactor: SCALE });
		await page.goto(pathToFileURL(file).href);
		await page.addStyleTag({ content: tokens });
		await page.evaluate(expand, mark);
		const size = await page.evaluate(() => ({
			width: Number(document.body.dataset.width),
			height: Number(document.body.dataset.height)
		}));
		await page.setViewportSize(size);
		await page.evaluate(async () => {
			await document.fonts.ready;
			await Promise.all(
				[...document.images].map((img) =>
					img.complete ? null : new Promise((done) => (img.onload = img.onerror = done))
				)
			);
			const broken = [...document.images].filter((img) => img.naturalWidth === 0);
			if (broken.length > 0) throw new Error(`missing image ${broken[0]!.getAttribute('src')}`);
		});
		const out = join(OUT, `${name}.png`);
		writeFileSync(out, smallerPng(await page.screenshot({ clip: { x: 0, y: 0, ...size } })));
		await page.close();
		const bytes = statSync(out).size;
		const kb = Math.round(bytes / 1024);
		console.log(`${name}.png ${size.width * SCALE}×${size.height * SCALE} ${kb} KB`);
		if (bytes > MAX_BYTES) {
			console.error(`${name}.png is over ${MAX_BYTES / 1024} KB`);
			failed = true;
		}
	}
} finally {
	await browser.close();
}
if (failed) process.exit(1);
