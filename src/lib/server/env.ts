import { env } from 'cloudflare:workers';

/** Worker secrets (`wrangler secret put`): not declared in wrangler.jsonc, so not in the generated `Env`. */
export interface Secrets {
	/** RB-05 field-encryption key: base64url of 32 random bytes (docs/RUNBOOK.md › HR data key). Optional. */
	HR_DATA_KEY?: string;
}

/** Cloudflare bindings for the app Worker. SvelteKit 3's Cloudflare adapter does not pass event.platform; this is the only accessor. */
export function getEnv(): Env & Secrets {
	return env as Env & Secrets;
}
