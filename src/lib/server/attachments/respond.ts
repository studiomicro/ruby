import { safeReturnTo } from '../return-to';
import type { DeleteResult, UploadResult } from './service';
import { ATTACHMENT_ERROR_MESSAGES, type AttachmentError } from '#lib/shared/attachments';

/**
 * How `/files` answers: JSON for a script that asked for it (`Accept: application/json`), otherwise a 303 back to
 * the page the form was on with a flash parameter the panel reads (`?uploaded=1`, `?upload_error=<code>`,
 * `?deleted=1`, `?delete_error=<code>`), so upload and delete work without JavaScript.
 */

export const ERROR_STATUS: Record<AttachmentError, number> = {
	too_large: 413,
	empty: 422,
	limit: 409,
	target_gone: 404,
	bad_request: 400,
	throttled: 429,
	storage: 503,
	forbidden: 403,
	not_found: 404,
	signed_out: 401
};

/** Every flash parameter, cleared before a new one is set. */
export const FLASH_PARAMS = ['uploaded', 'upload_error', 'deleted', 'delete_error'] as const;

export const wantsJson = (request: Request): boolean =>
	(request.headers.get('accept') ?? '').includes('application/json');

/** Where to send the browser: the validated `returnTo`, else the target's own page, else home. */
export function returnPath(returnTo: string | null, targetPath: string | null): string {
	const safe = returnTo ? safeReturnTo(returnTo) : '/';
	return safe !== '/' ? safe : (targetPath ?? '/');
}

/** `path` with its old flash parameters replaced by `name=value`, scrolled to the attachments panel. */
export function withFlash(
	path: string,
	name: (typeof FLASH_PARAMS)[number],
	value: string
): string {
	const url = new URL(path, 'http://ruby.invalid');
	for (const p of FLASH_PARAMS) url.searchParams.delete(p);
	url.searchParams.set(name, value);
	url.hash = 'attachments';
	return url.pathname + url.search + url.hash;
}

const redirect = (location: string) =>
	new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });

function refusal(
	request: Request,
	code: AttachmentError,
	location: string,
	flash: 'upload_error' | 'delete_error',
	status = ERROR_STATUS[code],
	retryAfter?: number
): Response {
	const headers: Record<string, string> = { 'cache-control': 'no-store' };
	if (retryAfter) headers['retry-after'] = String(retryAfter);
	if (wantsJson(request))
		return Response.json(
			{ error: code, message: ATTACHMENT_ERROR_MESSAGES[code] },
			{ status, headers }
		);
	return redirect(withFlash(location, flash, code));
}

export function uploadResponse(request: Request, result: UploadResult): Response {
	const location = returnPath(result.returnTo, result.targetPath);
	if (!result.ok)
		return refusal(
			request,
			result.code,
			location,
			'upload_error',
			result.status,
			result.retryAfter
		);
	if (wantsJson(request))
		return Response.json(result.attachment, {
			status: 201,
			headers: { 'cache-control': 'no-store' }
		});
	return redirect(withFlash(location, 'uploaded', '1'));
}

export function deleteResponse(
	request: Request,
	result: DeleteResult,
	returnTo: string | null
): Response {
	const location = returnPath(returnTo, result.targetPath);
	if (!result.ok) return refusal(request, result.code, location, 'delete_error');
	if (wantsJson(request))
		return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
	return redirect(withFlash(location, 'deleted', '1'));
}
