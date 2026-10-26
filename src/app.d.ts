import type { Db } from '#lib/server/db';
import type { SessionUser } from '#lib/server/auth/session';

declare global {
	namespace App {
		/** What an error page may show: SvelteKit's message plus, for an unexpected error, the id of its log line. */
		interface Error {
			id?: string;
			/** RB-20: set by hooks.client.ts when a form's request never reached the server (the device is offline). */
			offline?: boolean;
		}
		// Cloudflare bindings come from #lib/server/env (Kit 3 sets no Platform).
		interface Locals {
			/** Drizzle over the DB binding (hooks.server.ts, through getEnv()). */
			db: Db;
			/**
			 * The signed-in, active user, or null. Every query uses this id and role, never a client-supplied one;
			 * loads and actions read it through requireUser / requireAdmin (#lib/server/guards).
			 */
			user: SessionUser | null;
			/** The session cookie's token while signed in (sign-out revokes exactly this session). */
			sessionToken: string | null;
			/** A deployed HTTPS host: `__Host-` cookie name, the Secure flag and the Cloudflare Access check. */
			secure: boolean;
			/** Set by sign-out: the response then carries `Clear-Site-Data` so this browser drops its caches. */
			clearSiteData?: boolean;
		}
	}
}

export {};
