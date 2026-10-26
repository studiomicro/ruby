import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	DURATION_MS,
	FLIP_MAX_ITEMS,
	flip,
	flipAllowed,
	flipParams,
	measure,
	motionAllowed,
	pageTransitionAllowed,
	reducedMotion,
	rise
} from './motion';

const url = (path: string, origin = 'https://ruby.example.test') => new URL(path, origin);
const ok = {
	phone: true,
	supported: true,
	reduced: false,
	hidden: false,
	from: url('/'),
	to: url('/my-tasks')
};

/** A browser with or without reduced motion, visible or hidden. */
function browser({ reduce = false, hidden = false } = {}) {
	vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('reduce') }));
	vi.stubGlobal('document', { hidden });
}

afterEach(() => vi.unstubAllGlobals());

describe('motion module (B-AC1, B-AC5)', () => {
	it('on the server there is no reduced-motion signal and no motion', () => {
		expect(reducedMotion()).toBe(false);
		expect(motionAllowed()).toBe(false);
		expect(DURATION_MS.base).toBe(200);
	});

	it('motion runs only in a visible tab without reduced motion', () => {
		browser();
		expect(motionAllowed()).toBe(true);
		browser({ reduce: true });
		expect(reducedMotion()).toBe(true);
		expect(motionAllowed()).toBe(false);
		browser({ hidden: true });
		expect(motionAllowed()).toBe(false);
	});

	it('FLIP is capped at 50 items', () => {
		expect(FLIP_MAX_ITEMS).toBe(50);
		expect(flipAllowed(0, true)).toBe(true);
		expect(flipAllowed(50, true)).toBe(true);
		expect(flipAllowed(51, true)).toBe(false);
		expect(flipAllowed(3, false)).toBe(false);
		browser();
		expect(flipParams(50).duration).toBe(DURATION_MS.base);
		expect(flipParams(51).duration).toBe(0);
		browser({ reduce: true });
		expect(flipParams(3).duration).toBe(0);
	});

	it('page transitions: phones only, supported, not reduced, visible, a new path, never sign-in or sign-out', () => {
		expect(pageTransitionAllowed(ok)).toBe(true);
		expect(pageTransitionAllowed({ ...ok, phone: false })).toBe(false);
		expect(pageTransitionAllowed({ ...ok, supported: false })).toBe(false);
		expect(pageTransitionAllowed({ ...ok, reduced: true })).toBe(false);
		expect(pageTransitionAllowed({ ...ok, hidden: true })).toBe(false);
		expect(pageTransitionAllowed({ ...ok, from: null })).toBe(false);
		expect(pageTransitionAllowed({ ...ok, to: url('/?filter=x'), from: url('/') })).toBe(false);
		expect(
			pageTransitionAllowed({ ...ok, from: url('/calendar?date=1'), to: url('/calendar?date=2') })
		).toBe(false);
		expect(pageTransitionAllowed({ ...ok, to: url('/login') })).toBe(false);
		expect(pageTransitionAllowed({ ...ok, from: url('/login') })).toBe(false);
		expect(pageTransitionAllowed({ ...ok, to: url('/logout') })).toBe(false);
		expect(pageTransitionAllowed({ ...ok, to: url('/x', 'https://elsewhere.example.test') })).toBe(
			false
		);
	});

	it('a list row appears without motion under reduced motion', () => {
		browser({ reduce: true });
		expect(rise({} as Element).duration).toBe(0);
	});
});

describe('FLIP by hand (board)', () => {
	type Fake = {
		key: string;
		box: { left: number; top: number };
		animate: ReturnType<typeof vi.fn>;
	};
	const el = (key: string, left: number, top: number): Fake => ({
		key,
		box: { left, top },
		animate: vi.fn()
	});
	const root = (items: Fake[]) => ({
		querySelectorAll: () =>
			items.map((i) => ({
				getAttribute: () => i.key,
				getBoundingClientRect: () => i.box as DOMRect,
				animate: i.animate
			}))
	});

	it('slides each moved item from its old box, fades in a new one, leaves the rest', () => {
		browser();
		const a = el('a', 0, 0);
		const b = el('b', 0, 50);
		const before = measure(root([a, b]) as never, 'data-card');
		a.box = { left: 300, top: 0 }; // moved to another column
		const c = el('c', 0, 100); // new
		expect(flip(root([a, b, c]) as never, 'data-card', before)).toBe(2);
		expect(a.animate).toHaveBeenCalledWith(
			[{ transform: 'translate(-300px, 0px)' }, { transform: 'none' }],
			expect.objectContaining({ duration: DURATION_MS.base })
		);
		expect(b.animate).not.toHaveBeenCalled();
		expect(c.animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], expect.anything());
	});

	it('plays nothing above 50 items or under reduced motion', () => {
		const many = Array.from({ length: 51 }, (_, i) => el(String(i), 0, i));
		browser();
		const before = measure(root(many) as never, 'data-card');
		many[0]!.box = { left: 10, top: 0 };
		expect(flip(root(many) as never, 'data-card', before)).toBe(0);
		browser({ reduce: true });
		const one = [el('a', 0, 0)];
		const b1 = measure(root(one) as never, 'data-card');
		one[0]!.box = { left: 10, top: 0 };
		expect(flip(root(one) as never, 'data-card', b1)).toBe(0);
		expect(one[0]!.animate).not.toHaveBeenCalled();
	});
});
