import { fail, redirect } from '@sveltejs/kit';
import { FIELDS_REQUIRED, INVALID_CREDENTIALS, TOO_MANY_ATTEMPTS } from '#lib/server/auth/messages';
import {
	EMAIL_MAX_LENGTH,
	PASSWORD_MAX_LENGTH,
	signInWithPassword
} from '#lib/server/auth/password';
import { createPasswordSession, revokeSession, setSessionCookie } from '#lib/server/auth/session';
import { setupOpen } from '#lib/server/auth/setup';
import { overAttemptLimit } from '#lib/server/auth/throttle';
import { readFormBody, textField } from '#lib/server/forms';
import { safeReturnTo } from '#lib/server/return-to';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.user) redirect(303, safeReturnTo(url.searchParams.get('next')));
	// A fresh install has no account to sign in to: the first one is made at /setup.
	if (await setupOpen(locals.db)) redirect(303, '/setup');
	return {};
};

export const actions: Actions = {
	/** E-mail + password sign-in. One answer for every refusal (no account-existence oracle). */
	default: async ({ request, locals, cookies, url }) => {
		const form = await readFormBody(request);
		const email = textField(form, 'email').slice(0, EMAIL_MAX_LENGTH);
		const password = textField(form, 'password');
		const values = { email };
		if (!email.trim() || !password) return fail(400, { error: FIELDS_REQUIRED, values });
		const at = now();
		// Counted before any key derivation, so a flood costs one row write per attempt.
		if (await overAttemptLimit(locals.db, request, at, 'sign-in'))
			return fail(429, { error: TOO_MANY_ATTEMPTS, values });
		// Longer than any stored password can be: refused without deriving (says nothing about the account).
		if (password.length > PASSWORD_MAX_LENGTH)
			return fail(400, { error: INVALID_CREDENTIALS, values });
		const result = await signInWithPassword(locals.db, email, password, at);
		if (!result.ok) return fail(400, { error: INVALID_CREDENTIALS, values });
		const session = await createPasswordSession(locals.db, result.user.id, result.hash, at);
		if (!session) return fail(400, { error: INVALID_CREDENTIALS, values });
		// The cookie is about to be replaced: the session it held must not stay valid unseen.
		if (locals.sessionToken) await revokeSession(locals.db, locals.sessionToken, at);
		setSessionCookie(cookies, session.token, session.expiresAt, locals.secure);
		redirect(303, safeReturnTo(url.searchParams.get('next')));
	}
};
