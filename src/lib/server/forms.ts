import { error } from '@sveltejs/kit';

/**
 * Largest form body the app's actions read by default. The biggest foundation form (setup) is four short fields
 * plus a return path capped at RETURN_TO_MAX_LENGTH, so 8 KiB is far above any honest submission. A form with a
 * Markdown body names its own bound (`readFormBody(request, 256 * 1024)`).
 */
export const FORM_BODY_MAX_BYTES = 8 * 1024;
/** How long an action waits for a body to end; a client trickling bytes is cut off. */
const FORM_BODY_TIMEOUT_MS = 10_000;
/** What an HTML form sends and `formData()` parses (`text/plain` forms are refused). */
const FORM_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data']);

class BodyTooLarge extends Error {}
class BodyTimeout extends Error {}

/** First buffer size of a body read; it doubles as bytes arrive. */
const BODY_INITIAL_BYTES = 64 * 1024;

/**
 * At most `max` bytes of the body (and no more than a declared Content-Length); throws BodyTooLarge past it and
 * BodyTimeout once `timeoutMs` of wall-clock time has passed. One buffer, grown by doubling as bytes actually
 * arrive: a declared length is never preallocated, so a client that announces 8 MiB and sends nothing holds
 * 64 KiB, not 8 MiB.
 */
async function readCapped(request: Request, max: number, timeoutMs: number): Promise<Uint8Array> {
	const declared = Number(request.headers.get('content-length'));
	if (declared > max) throw new BodyTooLarge();
	if (!request.body) return new Uint8Array(0);
	const cap = Number.isSafeInteger(declared) && declared > 0 ? declared : max;
	let out = new Uint8Array(Math.min(cap, BODY_INITIAL_BYTES));
	let size = 0;
	const reader = request.body.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new BodyTimeout()), timeoutMs);
	});
	try {
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), deadline]);
			if (done) break;
			const needed = size + value.byteLength;
			if (needed > cap) throw new BodyTooLarge();
			if (needed > out.length) {
				const grown = new Uint8Array(Math.min(cap, Math.max(needed, out.length * 2)));
				grown.set(out.subarray(0, size));
				out = grown;
			}
			out.set(value, size);
			size = needed;
		}
	} catch (e) {
		reader.cancel().catch(() => {});
		throw e;
	} finally {
		clearTimeout(timer);
	}
	return out.subarray(0, size);
}

/**
 * The form an action was sent, read within `max` bytes (FORM_BODY_MAX_BYTES unless a form names its own bound) and
 * FORM_BODY_TIMEOUT_MS. Refused with `error()` (never a 500): 415 when it is not form-encoded, 400 when oversized
 * or unparseable, 408 when the body does not end in time. Ported from Montra's `readFormBody`.
 */
export async function readFormBody(
	request: Request,
	max: number = FORM_BODY_MAX_BYTES,
	timeoutMs: number = FORM_BODY_TIMEOUT_MS
): Promise<FormData> {
	const type = request.headers.get('content-type') ?? '';
	if (!FORM_TYPES.has(type.split(';', 1)[0]?.trim().toLowerCase() ?? ''))
		error(415, 'Unsupported content type');
	let body: Uint8Array;
	try {
		body = await readCapped(request, max, timeoutMs);
	} catch (e) {
		if (e instanceof BodyTimeout) error(408, 'Request body timeout');
		error(400, 'Invalid form');
	}
	const form = await new Response(body as BodyInit, { headers: { 'content-type': type } })
		.formData()
		.catch(() => null);
	if (!form) error(400, 'Invalid form');
	return form;
}

/** A text field's value ('' when missing or a file). Reads by name only, so no prototype keys are involved. */
export function textField(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === 'string' ? value : '';
}

/** A checkbox: true only for the value a checked box sends (`on`, or `value` when the input names one). */
export function checkboxField(form: FormData, name: string, value = 'on'): boolean {
	return textField(form, name) === value;
}

/** A field that must be one of `allowed` (a select of enum values); null for anything else. */
export function oneOfField<T extends string>(
	form: FormData,
	name: string,
	allowed: readonly T[]
): T | null {
	const value = textField(form, name);
	return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}
