import { fail } from '@sveltejs/kit';
import { changePassword } from '#lib/server/auth/change-password';
import { INVALID_CREDENTIALS, TOO_MANY_ATTEMPTS } from '#lib/server/auth/messages';
import {
	checkPasswordStrength,
	PASSWORD_ERRORS,
	PASSWORD_MAX_LENGTH,
	signInWithPassword
} from '#lib/server/auth/password';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import { updateOwnName } from '#lib/server/auth/users';
import { readFormBody, textField } from '#lib/server/forms';
import { requireUser } from '#lib/server/guards';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	const user = requireUser(event);
	return { account: { name: user.name, email: user.email, role: user.role } };
};

export const actions: Actions = {
	/** The display name. */
	name: async (event) => {
		const user = requireUser(event);
		const form = await readFormBody(event.request);
		const result = await updateOwnName(event.locals.db, user.id, textField(form, 'name'));
		if (!result.ok) return fail(400, { nameError: result.error });
		return { nameSaved: true };
	},

	/**
	 * Changes the password after proving the current one (a wrong one counts toward the account lockout), then
	 * revokes every other session of the account; this browser stays signed in.
	 */
	password: async (event) => {
		const user = requireUser(event);
		const { locals, request } = event;
		const form = await readFormBody(request);
		const current = textField(form, 'current');
		const next = textField(form, 'next');
		const at = now();
		if (await overUserAttemptLimit(locals.db, user.id, at, 'account-password'))
			return fail(429, { passwordErrors: { form: TOO_MANY_ATTEMPTS } });
		if (!current || current.length > PASSWORD_MAX_LENGTH)
			return fail(400, { passwordErrors: { current: 'Your current password is not correct.' } });
		const problem = checkPasswordStrength(next, user.email);
		if (problem) return fail(400, { passwordErrors: { next: PASSWORD_ERRORS[problem] } });
		const proof = await signInWithPassword(locals.db, user.email, current, at);
		if (!proof.ok || proof.user.id !== user.id)
			return fail(400, { passwordErrors: { current: 'Your current password is not correct.' } });
		const token = locals.sessionToken;
		if (!token) return fail(401, { passwordErrors: { form: INVALID_CREDENTIALS } });
		const changed = await changePassword(locals.db, user.id, proof.hash, token, next, at);
		if (!changed)
			return fail(409, {
				passwordErrors: { form: 'Your password was changed meanwhile. Try again.' }
			});
		return { passwordSaved: true };
	}
};
