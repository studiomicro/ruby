import { describe, expect, it } from 'vitest';
import {
	ancestorIds,
	buildTree,
	canMoveUnder,
	depthOf,
	parentOptions,
	placePosition,
	POSITION_STEP,
	subtreeIds,
	type ScopeRow
} from './tree';

const row = (id: string, parentId: string | null, position: number, title = id): ScopeRow => ({
	id,
	parentId,
	title,
	position
});

// a ─ b ─ c
//   └ d
// e
const rows = [
	row('c', 'b', 1),
	row('a', null, 2),
	row('b', 'a', 2),
	row('d', 'a', 1),
	row('e', null, 3)
];

describe('buildTree', () => {
	it('nests by parent and orders by position, then title', () => {
		const tree = buildTree(rows);
		expect(tree.map((n) => n.id)).toEqual(['a', 'e']);
		expect(tree[0]?.children.map((n) => n.id)).toEqual(['d', 'b']);
		expect(tree[0]?.children[1]?.children.map((n) => [n.id, n.depth])).toEqual([['c', 3]]);
		const tied = buildTree([row('x', null, 1, 'Zeta'), row('y', null, 1, 'Alpha')]);
		expect(tied.map((n) => n.title)).toEqual(['Alpha', 'Zeta']);
	});

	it('shows an orphan at the top level and drops nothing reachable; a cycle is left out', () => {
		const tree = buildTree([row('o', 'missing', 1), row('p', null, 2)]);
		expect(tree.map((n) => n.id)).toEqual(['o', 'p']);
		expect(buildTree([row('x', 'y', 1), row('y', 'x', 1)])).toEqual([]);
	});

	it('carries the "more" flag of a cut scope', () => {
		expect(buildTree([{ ...row('a', null, 1), more: true }])[0]?.more).toBe(true);
	});
});

describe('depth and subtree helpers', () => {
	it('ancestors, depth and subtree', () => {
		expect(ancestorIds(rows, 'c')).toEqual(['a', 'b']);
		expect(ancestorIds(rows, 'a')).toEqual([]);
		expect(depthOf(rows, 'c')).toBe(3);
		expect(depthOf(rows, 'nope')).toBe(0);
		expect([...subtreeIds(rows, 'a')].sort()).toEqual(['a', 'b', 'c', 'd']);
	});

	it('canMoveUnder refuses itself, a descendant and too deep a parent', () => {
		expect(canMoveUnder(rows, 'a', 3, 'a')).toBe(false);
		expect(canMoveUnder(rows, 'a', 3, 'c')).toBe(false);
		expect(canMoveUnder(rows, 'b', 2, 'e')).toBe(true);
		expect(canMoveUnder(rows, 'e', 1, null)).toBe(true);
		// A chain of 8: its leaf has no room for a child; the 7th has room for a leaf only.
		const chain = Array.from({ length: 8 }, (_, i) => row(`n${i + 1}`, i ? `n${i}` : null, 1));
		expect(canMoveUnder(chain, 'x', 1, 'n8')).toBe(false);
		expect(canMoveUnder(chain, 'x', 1, 'n7')).toBe(true);
		expect(canMoveUnder(chain, 'x', 2, 'n7')).toBe(false);
	});

	it('parentOptions indents by depth and filters', () => {
		const options = parentOptions(buildTree(rows), (n) => n.id !== 'e');
		expect(options.map((o) => o.label)).toEqual(['a', '— d', '— b', '— — c']);
	});
});

describe('placePosition', () => {
	const sibs = [
		{ id: 's1', position: 1024 },
		{ id: 's2', position: 2048 },
		{ id: 's3', position: 2048 + 1e-7 }
	];
	it('first, last, after and the empty case', () => {
		expect(placePosition([], { kind: 'last' })).toBe(POSITION_STEP);
		expect(placePosition(sibs, { kind: 'first' })).toBe(0);
		expect(placePosition(sibs, { kind: 'last' })).toBe(2048 + 1e-7 + 1024);
		expect(placePosition(sibs, { kind: 'after', siblingId: 's1' })).toBe(1536);
		expect(placePosition(sibs, { kind: 'after', siblingId: 's3' })).toBe(2048 + 1e-7 + 1024);
	});
	it('asks for a renumber when the gap is too small, and refuses an unknown sibling', () => {
		expect(placePosition(sibs, { kind: 'after', siblingId: 's2' })).toBe('renumber');
		expect(placePosition(sibs, { kind: 'after', siblingId: 'zz' })).toBe('missing-sibling');
	});
});
