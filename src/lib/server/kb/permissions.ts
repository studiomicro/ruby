import type { SessionUser } from '../auth/session';

/**
 * Owner decision 1 (RB-02): any active user creates, edits and moves pages. Deleting a page deletes its subtree:
 * an admin may delete any subtree; anyone else only a page they created whose live subpages they all created too
 * (red-team M1, orchestrator decision: otherwise moving someone's page under your own and deleting yours would
 * delete theirs). repo.ts › deletePage enforces the same rule inside its UPDATE; these helpers decide what to show.
 */
export type DeleteRefusal = 'not-creator' | 'others-in-subtree';

export const DELETE_REFUSALS: Record<DeleteRefusal, string> = {
	'not-creator': 'Only the page’s creator or an admin can delete it.',
	'others-in-subtree':
		'This page has subpages that other people created. Only an admin can delete it with them; move those pages out first.'
};

/** Why `actor` may not delete `page` (with `othersInSubtree` live pages below it by someone else), or null. */
export function deleteRefusal(
	actor: Pick<SessionUser, 'id' | 'role'>,
	page: { createdBy: string },
	othersInSubtree: number
): DeleteRefusal | null {
	if (actor.role === 'admin') return null;
	if (page.createdBy !== actor.id) return 'not-creator';
	return othersInSubtree > 0 ? 'others-in-subtree' : null;
}
