import { KB_LIMITS, type Placement } from './validation';

/**
 * Pure tree helpers over one scope's flat page list (RB-02 PRD › Page structure). They shape the outline and
 * pre-check a move for the form; the guarded SQL in repo.ts is the authority on every rule.
 */

export interface ScopeRow {
	id: string;
	parentId: string | null;
	title: string;
	position: number;
	/** Set when the row has children that were not loaded (a scope past KB_LIMITS.scopeRowsMax). */
	more?: boolean;
}

export interface TreeNode {
	id: string;
	title: string;
	depth: number;
	more: boolean;
	children: TreeNode[];
}

const byPositionThenTitle = (a: ScopeRow, b: ScopeRow) =>
	a.position - b.position || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

/**
 * The nested outline of `rows`. A row whose parent is not in the list is shown at the top level (it cannot happen
 * with consistent data, but no row is ever dropped from view). Rows on a parent cycle are unreachable and left out.
 */
export function buildTree(rows: readonly ScopeRow[]): TreeNode[] {
	const ids = new Set(rows.map((r) => r.id));
	const childrenOf = new Map<string | null, ScopeRow[]>();
	for (const row of rows) {
		const key = row.parentId !== null && ids.has(row.parentId) ? row.parentId : null;
		const list = childrenOf.get(key);
		if (list) list.push(row);
		else childrenOf.set(key, [row]);
	}
	const seen = new Set<string>();
	const build = (parent: string | null, depth: number): TreeNode[] =>
		(childrenOf.get(parent) ?? [])
			.slice()
			.sort(byPositionThenTitle)
			.filter((row) => !seen.has(row.id) && seen.add(row.id))
			.map((row) => ({
				id: row.id,
				title: row.title,
				depth,
				more: row.more === true,
				children: build(row.id, depth + 1)
			}));
	return build(null, 1);
}

/** The ids on the path from the top level down to `id`'s parent (ancestors only), top first. */
export function ancestorIds(rows: readonly ScopeRow[], id: string): string[] {
	const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
	const out: string[] = [];
	let at = parentOf.get(id) ?? null;
	while (at !== null && !out.includes(at) && out.length < 64) {
		out.unshift(at);
		at = parentOf.get(at) ?? null;
	}
	return out;
}

/** Depth of `id` in the scope (a top-level page is 1); 0 when `id` is not in `rows`. */
export function depthOf(rows: readonly ScopeRow[], id: string): number {
	return rows.some((r) => r.id === id) ? ancestorIds(rows, id).length + 1 : 0;
}

/** `id` and every page below it in `rows`. */
export function subtreeIds(rows: readonly ScopeRow[], id: string): Set<string> {
	const out = new Set([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const row of rows)
			if (row.parentId !== null && out.has(row.parentId) && !out.has(row.id)) {
				out.add(row.id);
				grew = true;
			}
	}
	return out;
}

/**
 * Whether a page whose own subtree is `height` levels tall (a leaf is 1) may move under `parentId` (null: the top
 * level) within `rows`, the target scope's pages: never under itself or a page below it, and never deeper than
 * KB_LIMITS.maxDepth.
 */
export function canMoveUnder(
	rows: readonly ScopeRow[],
	pageId: string,
	height: number,
	parentId: string | null
): boolean {
	if (parentId === null) return height <= KB_LIMITS.maxDepth;
	if (subtreeIds(rows, pageId).has(parentId)) return false;
	const parentDepth = depthOf(rows, parentId);
	return parentDepth > 0 && parentDepth + height <= KB_LIMITS.maxDepth;
}

/** Gap between positions; a new page goes this far after the last sibling. */
export const POSITION_STEP = 1024;
/** Below this gap a midpoint is not trusted (float precision): the siblings are renumbered first. */
export const POSITION_MIN_GAP = 1e-6;

/**
 * The position for a page placed among `siblings` (the target parent's live children, without the page itself,
 * in display order). `renumber` when two neighbours are too close for a midpoint; `missing-sibling` when an
 * `after:` sibling is not among them.
 */
export function placePosition(
	siblings: readonly { id: string; position: number }[],
	placement: Placement
): number | 'renumber' | 'missing-sibling' {
	if (siblings.length === 0) return POSITION_STEP;
	const first = siblings[0] as { position: number };
	const last = siblings[siblings.length - 1] as { position: number };
	if (placement.kind === 'first') return first.position - POSITION_STEP;
	if (placement.kind === 'last') return last.position + POSITION_STEP;
	const index = siblings.findIndex((s) => s.id === placement.siblingId);
	if (index < 0) return 'missing-sibling';
	const before = siblings[index] as { position: number };
	const next = siblings[index + 1];
	if (!next) return before.position + POSITION_STEP;
	if (next.position - before.position < POSITION_MIN_GAP) return 'renumber';
	return (before.position + next.position) / 2;
}

/** The outline as a flat, display-ordered list of options for a parent picker, indented by depth. */
export function parentOptions(
	nodes: readonly TreeNode[],
	include: (node: TreeNode) => boolean = () => true
): { value: string; label: string }[] {
	const out: { value: string; label: string }[] = [];
	const walk = (list: readonly TreeNode[]) => {
		for (const node of list) {
			if (include(node))
				out.push({ value: node.id, label: `${'— '.repeat(node.depth - 1)}${node.title}` });
			walk(node.children);
		}
	};
	walk(nodes);
	return out;
}
