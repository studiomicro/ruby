/**
 * Card order inside a board column. Positions are REAL; a move takes the midpoint of its neighbours, the first card
 * of an empty column gets 0, and a column whose gap has shrunk below RENUMBER_GAP is renumbered to 1024 · i first.
 */

/** Distance between neighbours after a renumber, and the step past either end of a column. */
export const POSITION_STEP = 1024;
/** Below this gap a midpoint loses precision: renumber the column first. */
export const RENUMBER_GAP = 1e-6;

/** The position between `prev` and `next` (null: no neighbour on that side). */
export function positionBetween(prev: number | null, next: number | null): number {
	if (prev === null && next === null) return 0;
	if (prev === null) return (next as number) - POSITION_STEP;
	if (next === null) return prev + POSITION_STEP;
	return prev + (next - prev) / 2;
}

/** True when there is no usable room left between two neighbours. */
export function needsRenumber(prev: number | null, next: number | null): boolean {
	return prev !== null && next !== null && next - prev < RENUMBER_GAP;
}
