import type { LeaveStatus } from '#lib/shared/enums';
import type { Viewer } from '../hr/visibility';

/**
 * Who decides and who cancels a leave request (PRD › Authorization per action, roadmap 8.1 decision 10 addendum),
 * as pure functions over what the server re-read. The SQL of `repo.ts` (`MAY_DECIDE`: approval queue, nav badge
 * and the guarded decide UPDATE) states the same rule; the tests hold both to it.
 */

export interface DecideContext {
	/** The account that submitted the request. */
	requesterUserId: string;
	/** The account currently linked to the employee (normally the requester). */
	employeeUserId: string | null;
	/** The active account of the employee's live, active direct manager, if any. */
	managerUserId: string | null;
	/** An active HR user other than the requester exists. */
	otherHrExists: boolean;
	/**
	 * An active admin other than the requester exists (an eligible approver too). Unknown counts as yes, so
	 * self-approval is never assumed.
	 */
	otherAdminExists?: boolean;
}

export type Approver = 'manager' | 'hr' | 'admin' | 'self';

/**
 * The designated approver: the direct manager's account; without one, HR; when no HR other than the requester
 * exists, an admin; when no admin other than the requester exists either, the requester (audited self-approval).
 */
export function approverFor(
	ctx: Pick<DecideContext, 'managerUserId' | 'otherHrExists' | 'otherAdminExists'>
): Approver {
	if (ctx.managerUserId) return 'manager';
	if (ctx.otherHrExists) return 'hr';
	return (ctx.otherAdminExists ?? true) ? 'admin' : 'self';
}

/**
 * Whether `actor` may approve or reject: the manager's account; any HR; an admin only when the employee has no
 * manager account and no HR other than the requester exists. The requester (owner decision 10 addendum) only while
 * nobody else is eligible: no manager account, no other active HR user and no other active admin
 * (`selfApprovalAllowed`), and only while they are both the submitter and the employee's linked account.
 */
export function canDecide(actor: Viewer, ctx: DecideContext): boolean {
	if (actor.userId === ctx.requesterUserId || actor.userId === ctx.employeeUserId)
		return (
			selfApprovalAllowed(ctx) &&
			actor.userId === ctx.requesterUserId &&
			actor.userId === ctx.employeeUserId
		);
	if (ctx.managerUserId && actor.userId === ctx.managerUserId) return true;
	if (actor.isHr) return true;
	return actor.isAdmin && !ctx.managerUserId && !ctx.otherHrExists;
}

/**
 * The requester may decide their own request: no manager account, no other active HR user, no other active admin
 * (the same condition as `approverFor` returning `self`).
 */
export const selfApprovalAllowed = (
	ctx: Pick<DecideContext, 'managerUserId' | 'otherHrExists' | 'otherAdminExists'>
): boolean => approverFor(ctx) === 'self';

/** A decision is an HR override (audited) when HR decides a request whose designated approver is the manager. */
export function isOverrideDecision(actor: Viewer, ctx: DecideContext): boolean {
	return actor.isHr && approverFor(ctx) === 'manager' && actor.userId !== ctx.managerUserId;
}

/** The requester deciding their own request (audited, flagged `self`). */
export const isSelfDecision = (actor: Viewer, ctx: DecideContext): boolean =>
	actor.userId === ctx.requesterUserId;

export type CancelRight = 'self' | 'override' | null;

/**
 * Cancel: the employee's currently linked account while pending, or while approved and not yet started
 * (`start_on > today`); HR any time (an audited override; flagged `self` when it is HR's own leave). Rejected and
 * canceled requests cannot be canceled. Ownership is the request's employee being the viewer's own employee now,
 * not who submitted it (a relinked record moves with its account).
 */
export function canCancel(
	actor: Viewer,
	request: { status: LeaveStatus; startOn: string; employeeId: string },
	today: string
): CancelRight {
	if (request.status !== 'pending' && request.status !== 'approved') return null;
	const own = actor.ownEmployeeId !== null && request.employeeId === actor.ownEmployeeId;
	if (own && (request.status === 'pending' || request.startOn > today)) return 'self';
	return actor.isHr ? 'override' : null;
}
