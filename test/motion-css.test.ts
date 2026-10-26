import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DURATION_MS, EASE, EASE_IN, EASE_OUT } from '../src/lib/ui/motion';

/**
 * RB-20 Part B: the motion rules (docs/features/rb-20-mobile-pwa/MOTION.md) for every stylesheet: `src/app.css` and
 * the `<style>` block of every Svelte file. Durations and easings come from the tokens, only transform and opacity
 * move (colour changes may fade), nothing moves outside `prefers-reduced-motion: no-preference` unless reduced motion
 * turns it off, one loop only (the skeleton shimmer, plus the existing busy spinner), and no `will-change`.
 */

interface Rule {
	file: string;
	selector: string;
	/** The enclosing at-rules (`@media …`, `@starting-style`), outermost first. */
	at: string[];
	decls: [string, string][];
}

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

/** The CSS of a file: app.css as it is, a Svelte file's `<style>` blocks. */
function cssOf(file: string): string {
	const text = readFileSync(file, 'utf8');
	const css = file.endsWith('.css')
		? text
		: [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
	return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** A small CSS walker: style rules with their at-rule context, and the properties each `@keyframes` changes. */
function parse(css: string, file: string) {
	const rules: Rule[] = [];
	const keyframes = new Map<string, Set<string>>();
	let i = 0;
	const declsOf = (text: string): [string, string][] =>
		text
			.split(';')
			.map((d) => d.trim())
			.filter((d) => d.includes(':'))
			.map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]);

	function block(at: string[], frames: string | null): string {
		let own = '';
		let buf = '';
		while (i < css.length) {
			const c = css[i++]!;
			if (c === '{') {
				const cut = buf.lastIndexOf(';') + 1;
				own += buf.slice(0, cut);
				const prelude = buf.slice(cut).trim();
				buf = '';
				if (prelude.startsWith('@keyframes')) {
					const name = prelude.split(/\s+/)[1]!;
					keyframes.set(name, keyframes.get(name) ?? new Set());
					block(at, name);
				} else if (prelude.startsWith('@')) {
					block([...at, prelude], null);
				} else if (frames) {
					for (const [prop] of declsOf(block(at, null))) keyframes.get(frames)!.add(prop);
				} else {
					rules.push({ file, selector: prelude, at, decls: declsOf(block(at, null)) });
				}
			} else if (c === '}') {
				return own + buf;
			} else buf += c;
		}
		return own + buf;
	}
	block([], null);
	return { rules, keyframes };
}

const SOURCES = ['src/app.css', ...files('src').filter((f) => f.endsWith('.svelte'))];
const parsed = SOURCES.map((file) => parse(cssOf(file), file));
const RULES = parsed.flatMap((p) => p.rules);
const KEYFRAMES = new Map(parsed.flatMap((p) => [...p.keyframes]));

const MOTION_PROPS = [
	'transition',
	'transition-duration',
	'transition-property',
	'transition-timing-function',
	'animation',
	'animation-name',
	'animation-duration',
	'animation-timing-function'
];
const TOKENS = [
	'--dur-fast',
	'--dur',
	'--dur-slow',
	'--dur-loop',
	'--ease',
	'--ease-out',
	'--ease-in'
];
/** What may change smoothly: movement (transform, opacity) and paint-only colour changes for hover, focus and press. */
const TRANSITION_PROPS = new Set([
	'transform',
	'opacity',
	'translate',
	'scale',
	'background-color',
	'color',
	'border-color',
	'box-shadow',
	'overlay',
	'display'
]);
const KEYFRAME_PROPS = new Set(['transform', 'opacity', 'translate', 'scale', 'rotate']);
const MOVING = /\b(transform|translate|scale|rotate)\b/;
/** The only loops: the skeleton shimmer (inside `aria-busy`) and the busy spinner of a button that is sending. */
const LOOPS = new Map([
	['src/app.css', /aria-busy/],
	[join('src', 'lib', 'ui', 'kit', 'Button.svelte'), /\.spinner/]
]);
/** Every file with motion. A new one must be added here, so it cannot slip past these rules. */
const MOTION_FILES = [
	'src/app.css',
	'src/lib/ui/comments/CommentThread.svelte',
	'src/lib/ui/kit/Button.svelte',
	'src/lib/ui/kit/Dialog.svelte',
	'src/lib/ui/kit/DropdownMenu.svelte',
	'src/lib/ui/kit/Select.svelte',
	'src/lib/ui/kit/Switch.svelte',
	'src/lib/ui/kit/Tabs.svelte',
	'src/lib/ui/kit/TextArea.svelte',
	'src/lib/ui/kit/TextField.svelte',
	'src/lib/ui/kit/Toaster.svelte',
	'src/lib/ui/pm/TaskChecklist.svelte',
	'src/lib/ui/pwa/OfflineBanner.svelte',
	'src/lib/ui/shell/UpdateBanner.svelte',
	'src/lib/ui/tasks/Board.svelte',
	'src/routes/(app)/+layout.svelte',
	'src/routes/(app)/calendar/+page.svelte',
	'src/routes/(app)/kb/PageTree.svelte',
	'src/routes/(app)/notifications/+page.svelte'
].map((f) => join(...f.split('/')));

const motionDecls = (rule: Rule) => rule.decls.filter(([p]) => MOTION_PROPS.includes(p));
/** The parts of a comma-separated value, ignoring commas inside parentheses. */
const parts = (value: string) => value.split(/,(?![^(]*\))/).map((p) => p.trim());
const where = (rule: Rule) => `${rule.file} ${rule.at.join(' ')} ${rule.selector}`;

describe('motion tokens (B-AC1)', () => {
	const css = readFileSync('src/app.css', 'utf8');
	const token = (name: string) => css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
	it('app.css defines the durations and easings, and motion.ts mirrors them', () => {
		expect(token('--dur-fast')).toBe(`${DURATION_MS.fast}ms`);
		expect(token('--dur')).toBe(`${DURATION_MS.base}ms`);
		expect(token('--dur-slow')).toBe(`${DURATION_MS.slow}ms`);
		expect(token('--dur-loop')).toBe(`${DURATION_MS.loop}ms`);
		expect(token('--ease')).toBe(EASE);
		expect(token('--ease-out')).toBe(EASE_OUT);
		expect(token('--ease-in')).toBe(EASE_IN);
		expect(DURATION_MS).toEqual({ fast: 120, base: 200, slow: 280, loop: 1200 });
	});
});

describe('motion rules (B-AC2, B-AC3)', () => {
	it('the walker sees the rules (sanity)', () => {
		expect(RULES.length).toBeGreaterThan(500);
		expect(KEYFRAMES.get('page-in')).toEqual(new Set(['opacity', 'transform']));
	});

	it('every duration and easing is a token (or 0); no literal times', () => {
		const bad: string[] = [];
		for (const rule of RULES)
			for (const [prop, value] of motionDecls(rule)) {
				for (const time of value.match(/(?<![\w-])\d*\.?\d+m?s\b/g) ?? [])
					if (!/^0m?s$/.test(time)) bad.push(`${where(rule)}: ${prop}: ${value}`);
				for (const [, name] of value.matchAll(/var\((--[\w-]+)\)/g))
					if (!TOKENS.includes(name!)) bad.push(`${where(rule)}: ${prop}: ${value}`);
				if (/\b(ease|ease-in|ease-out|ease-in-out)\b(?!-)/.test(value.replace(/var\([^)]*\)/g, '')))
					bad.push(`${where(rule)}: ${prop}: ${value} (keyword easing)`);
			}
		expect(bad).toEqual([]);
	});

	it('transitions change only transform, opacity and colours; never layout, never `all`', () => {
		const bad: string[] = [];
		for (const rule of RULES)
			for (const [prop, value] of rule.decls) {
				if (prop === 'transition')
					for (const part of parts(value)) {
						const name = part.split(/\s+/)[0]!;
						if (name !== 'none' && !TRANSITION_PROPS.has(name)) bad.push(`${where(rule)}: ${part}`);
					}
				if (prop === 'transition-property')
					for (const name of parts(value))
						if (!TRANSITION_PROPS.has(name)) bad.push(`${where(rule)}: ${name}`);
			}
		expect(bad).toEqual([]);
	});

	it('keyframes change only transform and opacity', () => {
		const bad = [...KEYFRAMES].flatMap(([name, props]) =>
			[...props].filter((p) => !KEYFRAME_PROPS.has(p)).map((p) => `@keyframes ${name}: ${p}`)
		);
		expect(bad).toEqual([]);
	});

	it('no will-change anywhere', () => {
		const bad = RULES.filter((r) => r.decls.some(([p]) => p === 'will-change')).map(where);
		expect(bad).toEqual([]);
	});

	it('nothing moves unless the person allows motion, or reduced motion turns it off for that selector', () => {
		const reduceSelectors = new Map<string, Set<string>>();
		for (const rule of RULES)
			if (rule.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a))) {
				const set = reduceSelectors.get(rule.file) ?? new Set<string>();
				for (const s of parts(rule.selector)) set.add(s);
				reduceSelectors.set(rule.file, set);
			}
		const bad: string[] = [];
		for (const rule of RULES) {
			if (rule.at.some((a) => /prefers-reduced-motion/.test(a))) continue;
			const moves = motionDecls(rule).some(([prop, value]) => {
				if (prop.startsWith('transition')) return MOVING.test(value);
				const names =
					prop === 'animation-name' ? parts(value) : parts(value).map((p) => p.split(/\s+/)[0]!);
				return names.some((n) => [...(KEYFRAMES.get(n) ?? [])].some((p) => MOVING.test(p)));
			});
			if (!moves) continue;
			const reduce = reduceSelectors.get(rule.file) ?? new Set();
			for (const selector of parts(rule.selector))
				if (!reduce.has(selector)) bad.push(`${where(rule)} (${selector})`);
		}
		expect(bad).toEqual([]);
	});

	it('the only loops are the skeleton shimmer and the busy spinner', () => {
		const bad: string[] = [];
		for (const rule of RULES)
			if (rule.decls.some(([p, v]) => p.startsWith('animation') && /\binfinite\b/.test(v))) {
				const allowed = LOOPS.get(rule.file);
				if (!allowed || !allowed.test(rule.selector)) bad.push(where(rule));
			}
		expect(bad).toEqual([]);
	});

	it('the page itself never animates: no motion on :root, html, body, main or *', () => {
		const bad = RULES.filter(
			(r) =>
				motionDecls(r).length > 0 &&
				parts(r.selector).some((s) => /^(:root|html|body|main|\*)$/.test(s))
		).map(where);
		expect(bad).toEqual([]);
	});

	it('the list of files with motion is complete (a new one is reviewed against these rules)', () => {
		const withMotion = SOURCES.filter((file) => {
			const source = readFileSync(file, 'utf8');
			return (
				parsed[SOURCES.indexOf(file)]!.rules.some((r) => motionDecls(r).length > 0) ||
				/\s(in|out|transition|animate):[\w]+/.test(source)
			);
		});
		expect(withMotion.sort()).toEqual([...MOTION_FILES].sort());
	});
});
