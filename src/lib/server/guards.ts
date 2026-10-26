import { error } from '@sveltejs/kit';
import type { SessionUser } from './auth/session';

/**
 * The one access rule (CLAUDE.md › Authorization): every load, form action, API route and file download starts
 * with one of these. hooks.server.ts (auth/gate.ts) already answers signed-out requests to `(app)` routes, so here a
 * missing user is a 401 that only fires if a route outside `(app)` forgets the gate; a member on an admin route gets
 * 403. Every active user may see every project and page, so there is no per-record rule beyond these two.
 *
 * Both take the RequestEvent (`requireUser(event)`) or its `locals` (`requireUser(locals)`).
 */
type WithLocals = { locals: App.Locals } | App.Locals;

const localsOf = (x: WithLocals): App.Locals => ('locals' in x ? x.locals : x);

/** The signed-in, active user; throws 401 when there is none. */
export function requireUser(event: WithLocals): SessionUser {
	const user = localsOf(event).user;
	if (!user) error(401, 'Sign in to continue.');
	return user;
}

/** The signed-in user when they are an admin; throws 401 signed out, 403 for a member. */
export function requireAdmin(event: WithLocals): SessionUser {
	const user = requireUser(event);
	if (user.role !== 'admin') error(403, 'Only admins can do this.');
	return user;
}

/** Whether a user is an admin, for display only (a hidden button is not authorization). */
export const isAdmin = (user: Pick<SessionUser, 'role'> | null | undefined) =>
	user?.role === 'admin';
