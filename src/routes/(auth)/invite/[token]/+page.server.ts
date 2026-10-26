import { fail, redirect } from '@sveltejs/kit';
import { acceptInvite, findLiveInvite } from '#lib/server/auth/invites';
import { TOO_MANY_ATTEMPTS } from '#lib/server/auth/messages';
import { PASSWORD_ERRORS, PASSWORD_MAX_LENGTH } from '#lib/server/auth/password';
import { revokeSession, setSessionCookie } from '#lib/server/auth/session';
import { overAttemptLimit } from '#lib/server/auth/throttle';
import { readFormBody, textField } from '#lib/server/forms';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/**
 * The invite link. The page shows the invited address and role only, never the token (it is already in the URL;
 * page data never repeats it). Every refused link — unknown, expired, revoked, used — gets the one same answer.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	const invite = await findLiveInvite(locals.db, params.token, now());
	return { invite, signedInAs: locals.user?.email ?? null };
};

export const actions: Actions = {
	/** Sets the name and password and signs the new account in; e-mail and role come from the invite. */
	default: async ({ request, locals, cookies, params }) => {
		const form = await readFormBody(request);
		const name = textField(form, 'name');
		const password = textField(form, 'password');
		const values = { name: name.slice(0, 200) };
		const at = now();
		if (await overAttemptLimit(locals.db, request, at, 'invite-accept'))
			return fail(429, { errors: { form: TOO_MANY_ATTEMPTS }, values });
		if (password.length > PASSWORD_MAX_LENGTH)
			return fail(400, { errors: { password: PASSWORD_ERRORS.too_long }, values });
		const result = await acceptInvite(locals.db, params.token, { name, password }, at);
		if (!result.ok) return fail(400, { errors: result.errors, values });
		// Whoever was signed in on this browser before is signed out first.
		if (locals.sessionToken) await revokeSession(locals.db, locals.sessionToken, at);
		setSessionCookie(cookies, result.token, result.expiresAt, locals.secure);
		redirect(303, '/');
	}
};
