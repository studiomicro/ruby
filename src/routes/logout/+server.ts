import { redirect } from '@sveltejs/kit';
import { clearSessionCookie, revokeSession } from '#lib/server/auth/session';
import { now } from '#lib/server/util';
import type { RequestHandler } from './$types';

/**
 * Signs this browser out: revokes the session of this cookie (other devices stay signed in), clears the cookie and
 * asks the browser to drop its caches (`Clear-Site-Data`, set by hooks.server.ts). POST only, behind the CSRF check;
 * a GET is 405, so a link or an image can never sign anyone out.
 */
export const POST: RequestHandler = async ({ locals, cookies, request }) => {
	await request.body?.cancel();
	if (locals.sessionToken) await revokeSession(locals.db, locals.sessionToken, now());
	clearSessionCookie(cookies, locals.secure);
	locals.clearSiteData = true;
	redirect(303, '/login');
};
