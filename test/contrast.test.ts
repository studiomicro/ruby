import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 2.2 AA contrast of the design tokens in src/app.css (docs/design/DESIGN_SYSTEM.md), in the light and the dark
 * theme: 4.5:1 for text (1.4.3), 3:1 for control boundaries, focus rings and state indicators (1.4.11), and 3:1 for
 * `--subtle`, which is for placeholders and decoration only.
 */

const css = readFileSync('src/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The custom properties declared in the first block that `selector` opens. */
function tokens(selector: string): Record<string, string> {
	const start = css.indexOf(`${selector} {`);
	if (start < 0) throw new Error(`no block for ${selector}`);
	const body = css.slice(start + selector.length + 2, css.indexOf('}', start));
	const out: Record<string, string> = {};
	for (const match of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g))
		out[match[1]!] = match[2]!.trim();
	return out;
}

const light = tokens(':root');
const dark = tokens(":root[data-theme='dark']");
const darkMedia = tokens(":root:not([data-theme='light'])");

function rgb(hex: string): [number, number, number] {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
	const n = parseInt(m[1]!, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(hex: string): number {
	const [r, g, b] = rgb(hex).map((v) => {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
	const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
	return (x + 0.05) / (y + 0.05);
}

const TEXT = 4.5;
const UI = 3;

/** [foreground token, background tokens, minimum ratio]. */
const PAIRS: [string, string[], number][] = [
	['fg', ['bg', 'surface', 'elevated', 'surface-2', 'surface-3', 'control'], TEXT],
	['fg-strong', ['bg', 'surface'], TEXT],
	['muted', ['bg', 'surface', 'elevated', 'surface-2', 'surface-3', 'control'], TEXT],
	['accent', ['bg', 'surface', 'surface-2', 'accent-soft'], TEXT],
	['accent-hover', ['bg', 'surface'], TEXT],
	['accent-fg', ['accent'], TEXT],
	['brand-fg', ['brand', 'brand-hover'], TEXT],
	['danger', ['bg', 'surface', 'surface-2', 'danger-soft'], TEXT],
	['success', ['bg', 'surface', 'success-soft'], TEXT],
	['warning', ['bg', 'surface', 'warning-soft'], TEXT],
	// The checkbox mark (--surface) on its checked fill (--fg).
	['surface', ['fg'], TEXT],
	['border-control', ['bg', 'surface', 'control'], UI],
	['field-focus', ['surface', 'control'], UI],
	['ring', ['bg', 'surface', 'surface-2', 'control'], UI],
	['brand', ['bg', 'surface'], UI],
	// A switch knob: grey on the control when off.
	['muted', ['control'], UI],
	['subtle', ['bg', 'surface', 'control'], UI]
];

describe.each([
	['light', light],
	['dark', dark]
])('%s theme contrast', (_theme, theme) => {
	for (const [fg, bgs, min] of PAIRS)
		for (const bg of bgs)
			it(`--${fg} on --${bg} is at least ${min}:1`, () => {
				const ratio = contrast(theme[fg]!, theme[bg]!);
				expect(ratio, `${theme[fg]} on ${theme[bg]}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
					min
				);
			});
});

describe('theme blocks', () => {
	it('the prefers-color-scheme dark block and [data-theme=dark] declare the same values', () => {
		expect(darkMedia).toEqual(dark);
	});
	it('every colour token of the light theme has a dark value', () => {
		for (const name of Object.keys(dark)) expect(light, `--${name}`).toHaveProperty(name);
		for (const [name, value] of Object.entries(light))
			if (/^#[0-9a-f]{6}$/i.test(value)) expect(dark, `--${name}`).toHaveProperty(name);
	});
	it('the contrast helper matches known WCAG values', () => {
		expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
		expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
	});
});
