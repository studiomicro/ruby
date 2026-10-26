import { error, fail, redirect } from '@sveltejs/kit';
import { TOO_MANY_ATTEMPTS } from '#lib/server/auth/messages';
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_ERRORS } from '#lib/server/auth/password';
import { setSessionCookie } from '#lib/server/auth/session';
import { createFirstAdmin, setupOpen } from '#lib/server/auth/setup';
import { overAttemptLimit } from '#lib/server/auth/throttle';
import { readFormBody, textField } from '#lib/server/forms';
import { now } from '#lib/server/util';
import type { Actions, PageServerLoad } from './$types';

/** `/setup` exists only while no account does; afterwards it is a plain 404 (CLAUDE.md › First-user setup). */
export const load: PageServerLoad = async ({ locals }) => {
	if (!(await setupOpen(locals.db))) error(404, 'Not Found');
	return {};
};

export const actions: Actions = {
	/** Creates the first account as admin and signs it in (auth/setup.ts holds the race-safe guard). */
	default: async ({ request, locals, cookies }) => {
		// Closed: 404 before the body, the throttle or any key derivation (the guarded INSERT stays the real gate).
		if (!(await setupOpen(locals.db))) error(404, 'Not Found');
		const form = await readFormBody(request);
		const name = textField(form, 'name');
		const email = textField(form, 'email').slice(0, EMAIL_MAX_LENGTH);
		const password = textField(form, 'password');
		const values = { name: name.slice(0, 200), email };
		const at = now();
		if (await overAttemptLimit(locals.db, request, at, 'setup'))
			return fail(429, { errors: { form: TOO_MANY_ATTEMPTS }, values });
		if (password.length > PASSWORD_MAX_LENGTH)
			return fail(400, { errors: { password: PASSWORD_ERRORS.too_long }, values });
		const result = await createFirstAdmin(locals.db, { name, email, password }, at);
		if (!result.ok) {
			if (result.closed) error(404, 'Not Found');
			return fail(400, { errors: result.errors, values });
		}
		setSessionCookie(cookies, result.token, result.expiresAt, locals.secure);
		redirect(303, '/');
	}
};
