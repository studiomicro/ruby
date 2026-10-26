export const newId = (): string => crypto.randomUUID();

/** The current time as UTC milliseconds: the one clock every write stores (CLAUDE.md › timestamps). */
export const now = (): number => Date.now();

/** True when a D1 error is a UNIQUE constraint violation (message and `cause` are both checked). */
export function isUniqueViolation(e: unknown): boolean {
	const msg =
		String((e as Error)?.message ?? e) + String((e as { cause?: Error })?.cause?.message ?? '');
	return msg.includes('UNIQUE constraint failed');
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: string): Promise<string> {
	return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)));
}

/** URL-safe base64 of `bytes` random bytes from the CSPRNG (session and invite tokens). */
export function randomToken(bytes = 32): string {
	const b = crypto.getRandomValues(new Uint8Array(bytes));
	return btoa(String.fromCharCode(...b))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/**
 * What a log line may say about an error: its class name and, for a D1/Drizzle error, its cause's class name and
 * code. Never the message, which can carry bound parameters (Drizzle's `Failed query: … params: …`) and so user
 * data such as page text or e-mail addresses.
 */
export function errorLabel(e: unknown): string {
	const name = (x: unknown) =>
		x instanceof Error ? x.name : typeof x === 'object' && x !== null ? 'object' : typeof x;
	const cause = e instanceof Error ? (e as { cause?: unknown }).cause : undefined;
	const code = (cause as { code?: unknown } | undefined)?.code;
	return [
		name(e),
		...(cause === undefined ? [] : [name(cause)]),
		...(typeof code === 'string' || typeof code === 'number' ? [String(code).slice(0, 40)] : [])
	].join(' / ');
}
