import { cubicOut } from 'svelte/easing';
import { fade, fly, type TransitionConfig } from 'svelte/transition';

/**
 * Ruby's motion, script side (RB-20 Part B, docs/features/rb-20-mobile-pwa/MOTION.md). Motion explains a change (a
 * sheet opened, a card moved, a row was saved) and never decorates. It moves only `transform` and `opacity`, never
 * runs in a hidden tab, and under `prefers-reduced-motion: reduce` nothing moves (at most an opacity fade remains).
 *
 * The numbers mirror the tokens in src/app.css (`--dur-fast`, `--dur`, `--dur-slow`, `--dur-loop`, `--ease*`);
 * test/motion-css.test.ts checks that they agree. Svelte's transitions and `element.animate()` run as Web Animations:
 * no `style` attribute and no `<style>` tag is written, so the CSP (`style-src 'self'`) stays as it is.
 */

export const DURATION_MS = { fast: 120, base: 200, slow: 280, loop: 1200 } as const;
export const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
export const EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
export const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)';
/** Above this many items on screen a list or the board skips FLIP: the item simply appears in its new place. */
export const FLIP_MAX_ITEMS = 50;
/** How long a just-saved row keeps its highlight (`data-saved`). */
export const SAVED_MS = 1200;
/** The phone layout's breakpoint (the shell's tab bar below 768 px). */
export const PHONE_QUERY = '(max-width: 767px)';

/** The person asked for less motion. False on the server (and wherever matchMedia is missing). */
export function reducedMotion(): boolean {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Script-driven movement may run now: in a browser, in a visible tab, without reduced motion. */
export function motionAllowed(): boolean {
	return typeof document !== 'undefined' && !document.hidden && !reducedMotion();
}

/** Whether a FLIP over `count` items may run (movement allowed and at most FLIP_MAX_ITEMS items). */
export function flipAllowed(count: number, allowed: boolean = motionAllowed()): boolean {
	return allowed && count <= FLIP_MAX_ITEMS;
}

/** Where a page transition never runs: sign-out and sign-in, so no snapshot of one person's page fades into the next. */
const NO_TRANSITION_PATHS = new Set(['/logout', '/login']);

/**
 * Whether a navigation gets the page cross-fade (owner default O1: phones only). Never without browser support, under
 * reduced motion, in a hidden tab, across origins, when only the query or hash changes (a filter, a calendar step),
 * or to or from the sign-in and sign-out pages.
 */
export function pageTransitionAllowed(input: {
	phone: boolean;
	supported: boolean;
	reduced: boolean;
	hidden: boolean;
	from?: URL | null;
	to?: URL | null;
}): boolean {
	const { phone, supported, reduced, hidden, from, to } = input;
	if (!phone || !supported || reduced || hidden || !from || !to) return false;
	if (from.origin !== to.origin || from.pathname === to.pathname) return false;
	return !NO_TRANSITION_PATHS.has(from.pathname) && !NO_TRANSITION_PATHS.has(to.pathname);
}

// ── Svelte transitions (always used with `|local`, so nothing plays on the first render) ───────────────────────

/** A new list row or banner: rises 8 px and fades in. Under reduced motion it simply appears. */
export function rise(node: Element, { y = 8 }: { y?: number } = {}): TransitionConfig {
	if (!motionAllowed()) return { duration: 0 };
	return fly(node, { y, duration: DURATION_MS.base, easing: cubicOut });
}

/** A banner or toast: rises 8 px, or only fades (in `--dur-fast`) under reduced motion. */
export function riseOrFade(node: Element, { y = 8 }: { y?: number } = {}): TransitionConfig {
	if (reducedMotion()) return fade(node, { duration: DURATION_MS.fast });
	return rise(node, { y });
}

/** Something leaving: fades out in `--dur-fast`. Under reduced motion lists drop it at once (`instant: true`). */
export function leave(
	node: Element,
	{ instant = false }: { instant?: boolean } = {}
): TransitionConfig {
	if (instant && !motionAllowed()) return { duration: 0 };
	return fade(node, { duration: DURATION_MS.fast });
}

/** The one-shot count bump on a board column header (1 to 1.12 to 1). Nothing under reduced motion. */
export function bump(node?: Element): TransitionConfig {
	void node;
	if (!motionAllowed()) return { duration: 0 };
	return {
		duration: DURATION_MS.base,
		css: (t) => `transform: scale(${(1 + 0.12 * Math.sin(Math.PI * t)).toFixed(3)})`
	};
}

/** Params for `animate:flip` on a keyed list of `count` items: duration 0 above the cap or without motion. */
export function flipParams(count: number): { duration: number; easing: (t: number) => number } {
	return { duration: flipAllowed(count) ? DURATION_MS.base : 0, easing: cubicOut };
}

// ── FLIP by hand, for lists whose items are not the only child of their keyed `{#each}` (the board) ─────────────

export type Positions = Map<string, DOMRect>;

/** The on-screen box of every element under `root` that carries `attr`, by the attribute's value. */
export function measure(
	root: Pick<Element, 'querySelectorAll'> | undefined,
	attr: string
): Positions {
	const out: Positions = new Map();
	if (!root) return out;
	for (const el of root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
		const key = el.getAttribute(attr);
		if (key) out.set(key, el.getBoundingClientRect());
	}
	return out;
}

/**
 * Plays the move from the boxes in `before` to where each element is now (First, Last, Invert, Play): every element
 * that moved slides from its old place, also across columns (the element is matched by its key, not its node), and
 * one that was not there before fades in. Runs only when `flipAllowed(count)`; returns how many it animated.
 */
export function flip(
	root: Pick<Element, 'querySelectorAll'> | undefined,
	attr: string,
	before: Positions
): number {
	if (!root) return 0;
	const elements = [...root.querySelectorAll<HTMLElement>(`[${attr}]`)];
	if (!flipAllowed(elements.length)) return 0;
	let played = 0;
	for (const el of elements) {
		const old = before.get(el.getAttribute(attr) ?? '');
		if (!old) {
			el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATION_MS.fast, easing: EASE });
			played += 1;
			continue;
		}
		const now = el.getBoundingClientRect();
		const dx = old.left - now.left;
		const dy = old.top - now.top;
		if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
		el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
			duration: DURATION_MS.base,
			easing: EASE_OUT
		});
		played += 1;
	}
	return played;
}

/** Marks `el` as just saved (`data-saved`, the highlight in app.css) for SAVED_MS. */
export function markSaved(el: Element | null | undefined): void {
	if (!el) return;
	el.setAttribute('data-saved', '');
	setTimeout(() => el.removeAttribute('data-saved'), SAVED_MS);
}
