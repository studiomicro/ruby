import { fail } from '@sveltejs/kit';
import { USER_ROLES, USER_STATUSES } from '#lib/shared/enums';
import {
	createInvite,
	invitePath,
	listPendingInvites,
	revokeInvite
} from '#lib/server/auth/invites';
import { listUsers, setUserRole, setUserStatus, unlockUser } from '#lib/server/auth/users';
import { oneOfField, readFormBody, textField } from '#lib/server/forms';
import { requireAdmin } from '#lib/server/guards';
import { setHrFlag } from '#lib/server/hr/grant';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/** User management: every account, the pending invites (never their tokens) and the actions on them. */
export const load: PageServerLoad = async (event) => {
	const admin = requireAdmin(event);
	const at = now();
	const [users, invites] = await Promise.all([
		listUsers(event.locals.db, at),
		listPendingInvites(event.locals.db, at)
	]);
	return { users, invites, selfId: admin.id };
};

export const actions: Actions = {
	/**
	 * Creates an invite and returns its link in this one response only (the page shows it to copy); D1 keeps the
	 * token's hash. The link is built from this request's origin.
	 */
	invite: async (event) => {
		const admin = requireAdmin(event);
		const form = await readFormBody(event.request);
		const email = textField(form, 'email');
		const role = oneOfField(form, 'role', USER_ROLES);
		if (!role) return fail(400, { inviteError: 'Choose a role.', inviteEmail: email });
		const result = await createInvite(event.locals.db, admin.id, email, role, now());
		if (!result.ok) return fail(400, { inviteError: result.error, inviteEmail: email });
		return {
			invited: {
				email: email.trim().toLowerCase(),
				role,
				link: `${event.url.origin}${invitePath(result.token)}`,
				expiresAt: result.expiresAt
			}
		};
	},

	revokeInvite: async (event) => {
		const admin = requireAdmin(event);
		const form = await readFormBody(event.request);
		const ok = await revokeInvite(event.locals.db, admin.id, textField(form, 'inviteId'), now());
		if (!ok) return fail(400, { rowError: 'That invite was already used or revoked.' });
		return { rowNotice: 'Invite revoked.' };
	},

	/** Disables (signs out everywhere and revokes their pending invites) or re-enables a user. */
	setStatus: async (event) => {
		const admin = requireAdmin(event);
		const form = await readFormBody(event.request);
		const status = oneOfField(form, 'status', USER_STATUSES);
		if (!status) return fail(400, { rowError: 'Unknown status.' });
		const result = await setUserStatus(
			event.locals.db,
			admin.id,
			textField(form, 'userId'),
			status,
			now()
		);
		if (!result.ok) return fail(400, { rowError: result.error });
		return { rowNotice: status === 'disabled' ? 'User disabled and signed out.' : 'User enabled.' };
	},

	setRole: async (event) => {
		const admin = requireAdmin(event);
		const form = await readFormBody(event.request);
		const role = oneOfField(form, 'role', USER_ROLES);
		if (!role) return fail(400, { rowError: 'Choose a role.' });
		const result = await setUserRole(
			event.locals.db,
			admin.id,
			textField(form, 'userId'),
			role,
			now()
		);
		if (!result.ok) return fail(400, { rowError: result.error });
		return { rowNotice: 'Role changed.' };
	},

	/**
	 * RB-05: grants or revokes the HR capability (`isHr` = `1` or `0`), audited in the HR audit log. Admin only; an
	 * admin may grant themselves (owner answer 2026-10-26: the owner is the only HR user).
	 */
	setHr: async (event) => {
		const admin = requireAdmin(event);
		const form = await readFormBody(event.request);
		const value = textField(form, 'isHr');
		if (value !== '0' && value !== '1') return fail(400, { rowError: 'Unknown HR setting.' });
		const result = await setHrFlag(
			event.locals.db,
			admin.id,
			textField(form, 'userId'),
			value === '1',
			now()
		);
		if (!result.ok) return fail(400, { rowError: result.error });
		return { rowNotice: value === '1' ? 'HR access granted.' : 'HR access revoked.' };
	},

	/** Ends a sign-in lock (too many wrong passwords) before its 15 minutes are over. */
	unlock: async (event) => {
		const admin = requireAdmin(event);
		const form = await readFormBody(event.request);
		const result = await unlockUser(event.locals.db, admin.id, textField(form, 'userId'), now());
		if (!result.ok) return fail(400, { rowError: result.error });
		return { rowNotice: 'Account unlocked.' };
	}
};
