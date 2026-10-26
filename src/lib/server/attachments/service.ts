import { error, type RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from '../auth/session';
import { overUserAttemptLimit, retryAfterSeconds } from '../auth/throttle';
import { getEnv } from '../env';
import { isUuid } from '../kb/validation';
import { errorLabel, newId, now } from '../util';
import { classify, INLINE_TYPES, OCTET_STREAM, SERVED_TYPES } from './content-type';
import { contentDisposition } from './disposition';
import { cleanFilename } from './filename';
import { MultipartError, MultipartReader } from './multipart';
import { canDeleteAttachment } from './permissions';
import { R2Writer, StorageError } from './r2-writer';
import {
	countLive,
	getAttachment,
	insertAttachmentGuarded,
	isActiveUser,
	tombstoneAttachment,
	type AttachmentRow
} from './repo';
import { liveTargetPath } from './target';
import { ATTACHMENT_LIMITS, type AttachmentError } from '#lib/shared/attachments';
import { TARGET_KINDS, type TargetKind } from '#lib/shared/enums';

/**
 * RB-04 upload, download and delete. R2 first, then D1 (no transaction spans both): an object whose row was never
 * written is deleted again; a row is tombstoned before its object is deleted. Logs carry attachment ids, R2 keys
 * and error classes only — never a file name, file content or user id.
 */

/** Uploads per user per 10-minute window (owner decision 2026-10-26). */
export const UPLOAD_THROTTLE_MAX = 20;
/** The one answer for a malformed, unknown, deleted or orphaned file id (no existence oracle). */
export const FILE_NOT_FOUND = 'File not found.';

export type UploadResult =
	| {
			ok: true;
			attachment: { id: string; filename: string; sizeBytes: number; contentType: string };
			targetPath: string;
			returnTo: string | null;
	  }
	| {
			ok: false;
			code: AttachmentError;
			/** 415 for a body that is not multipart; otherwise the code's own status. */
			status?: number;
			targetPath: string | null;
			returnTo: string | null;
			retryAfter?: number;
	  };

export type DeleteResult =
	| { ok: true; targetPath: string }
	| { ok: false; code: 'not_found' | 'forbidden' | 'bad_request'; targetPath: string | null };

/** A stored object with no row: the RUNBOOK's manual sweep removes it. Key and error class only. */
const logOrphan = (key: string, e: unknown) =>
	console.error('attachment_orphan_candidate', { key, error: errorLabel(e) });

/** Text fields an upload form sends; each is read only when it comes before the file part. */
const UPLOAD_FIELDS = new Set(['targetKind', 'targetId', 'returnTo']);
/** The longest text field value read (a return path is at most RETURN_TO_MAX_LENGTH). */
const FIELD_MAX_BYTES = 4096;

/** The file part being streamed and where it goes. */
interface StreamedUpload {
	writer: R2Writer;
	kind: TargetKind;
	targetId: string;
	targetPath: string;
	filename: string;
	/** Set from the first bytes when R2 is first written. */
	contentType: string;
}

/** Why a streamed upload stopped early. */
class Refusal extends Error {
	constructor(
		readonly code: AttachmentError,
		readonly targetPath: string | null = null
	) {
		super(code);
	}
}

/**
 * One upload from `event` by `user`. The multipart body is streamed (multipart.ts), never buffered whole: the
 * fields `targetKind` and `targetId` must come before the `file` part (an HTML form and the panel send them in that
 * order), so the target and the per-item cap are checked before a byte of the file is kept. The file then goes to
 * R2 through R2Writer, which holds at most one 5 MiB part; the size cap is checked on every chunk. The object is
 * stored only once the whole body has been read, then the guarded D1 insert decides.
 */
export async function uploadAttachment(
	event: RequestEvent,
	user: SessionUser
): Promise<UploadResult> {
	const db = event.locals.db;
	const at = now();
	let returnTo = event.url.searchParams.get('returnTo');
	const refuse = (code: AttachmentError, targetPath: string | null = null, status?: number) =>
		({ ok: false, code, status, targetPath, returnTo }) as const;

	if (await overUserAttemptLimit(db, user.id, at, 'upload', UPLOAD_THROTTLE_MAX))
		return { ...refuse('throttled'), retryAfter: retryAfterSeconds(at) };

	const reader = MultipartReader.open(event.request);
	if (typeof reader === 'string')
		return reader === 'too_large'
			? refuse('too_large')
			: refuse('bad_request', null, reader === 'unsupported' ? 415 : 400);

	const files = getEnv().FILES;
	const fields = new Map<string, string>();
	const id = newId();
	// Never derived from the file name or any other input.
	const r2Key = `att/${crypto.randomUUID()}`;
	let upload: StreamedUpload | null = null;

	try {
		for (let part = await reader.next(); part; part = await reader.next()) {
			if (part.filename === null) {
				if (UPLOAD_FIELDS.has(part.name) && !fields.has(part.name)) {
					// An over-long value is dropped: a missing target is refused below, a return path falls back.
					const value = await reader.text(FIELD_MAX_BYTES);
					if (value !== null) fields.set(part.name, value);
					if (part.name === 'returnTo' && value) returnTo = value;
				}
				continue; // next() skips whatever was not read
			}
			if (part.name !== 'file') continue;
			if (upload) throw new Refusal('bad_request', upload.targetPath);
			const kindValue = fields.get('targetKind') ?? '';
			const kind = (TARGET_KINDS as readonly string[]).includes(kindValue)
				? (kindValue as TargetKind)
				: null;
			const targetId = (fields.get('targetId') ?? '').toLowerCase();
			if (!kind || !isUuid(targetId)) throw new Refusal('bad_request');
			const targetPath = await liveTargetPath(db, kind, targetId);
			if (!targetPath) throw new Refusal('target_gone');
			if ((await countLive(db, kind, targetId)) >= ATTACHMENT_LIMITS.maxPerTarget)
				throw new Refusal('limit', targetPath);

			const filename = cleanFilename(part.filename);
			const current: StreamedUpload = {
				kind,
				targetId,
				targetPath,
				filename,
				contentType: OCTET_STREAM,
				writer: new R2Writer(files, r2Key, (head): R2PutOptions => {
					// The type comes from the cleaned name and the first bytes, never from the client.
					current.contentType = classify(filename, head).contentType;
					return {
						httpMetadata: { contentType: current.contentType },
						customMetadata: { attachmentId: id }
					};
				})
			};
			upload = current;
			await reader.pipe(async (chunk) => {
				if (current.writer.size + chunk.length > ATTACHMENT_LIMITS.maxBytes)
					throw new Refusal('too_large', targetPath);
				await current.writer.write(chunk);
			});
			if (current.writer.size === 0) throw new Refusal('empty', targetPath);
		}
		if (!upload) throw new Refusal('bad_request');
		await upload.writer.finish();
	} catch (e) {
		reader.cancel();
		const targetPath = e instanceof Refusal ? e.targetPath : (upload?.targetPath ?? null);
		if (upload && !(await upload.writer.discard())) logOrphan(r2Key, e);
		if (e instanceof Refusal) return refuse(e.code, targetPath);
		if (e instanceof MultipartError) return refuse(e.reason, targetPath);
		if (e instanceof StorageError) {
			console.error('attachment_put_failed', { id, error: errorLabel(e.cause) });
			return refuse('storage', targetPath);
		}
		throw e;
	}

	const { kind, targetId, targetPath, filename, contentType, writer } = upload;
	let written: boolean;
	try {
		written = await insertAttachmentGuarded(db, {
			id,
			targetKind: kind,
			targetId,
			r2Key,
			filename,
			contentType,
			sizeBytes: writer.size,
			uploadedBy: user.id,
			createdAt: at
		});
	} catch (e) {
		console.error('attachment_insert_failed', { id, error: errorLabel(e) });
		if (!(await writer.discard())) logOrphan(r2Key, e);
		return refuse('storage', targetPath);
	}
	if (!written) {
		// The cap was reached, the target went away or the uploader was deactivated while the body streamed.
		if (!(await writer.discard())) logOrphan(r2Key, 'guard');
		if (!(await isActiveUser(db, user.id))) return refuse('signed_out');
		const stillLive = await liveTargetPath(db, kind, targetId);
		return stillLive ? refuse('limit', stillLive) : refuse('target_gone');
	}
	return {
		ok: true,
		attachment: { id, filename, sizeBytes: writer.size, contentType },
		targetPath,
		returnTo
	};
}

/** The live attachment `idParam` names whose task or page is live too, with that parent's path; else null. */
async function liveAttachment(
	event: RequestEvent,
	idParam: string | undefined
): Promise<{ row: AttachmentRow; targetPath: string } | null> {
	const id = (idParam ?? '').toLowerCase();
	if (!isUuid(id)) return null;
	const row = await getAttachment(event.locals.db, id);
	if (!row) return null;
	const targetPath = await liveTargetPath(event.locals.db, row.targetKind, row.targetId);
	return targetPath ? { row, targetPath } : null;
}

/** Headers every file response carries, a 304 included. */
function fileHeaders(row: AttachmentRow, inline: boolean, etag: string): Headers {
	const type = SERVED_TYPES.has(row.contentType) ? row.contentType : OCTET_STREAM;
	const showInline = inline && INLINE_TYPES.has(type);
	return new Headers({
		'content-type': type,
		'content-disposition': contentDisposition(showInline ? 'inline' : 'attachment', row.filename),
		'x-content-type-options': 'nosniff',
		// frame-ancestors and X-Frame-Options: no page may frame a file (thumbnails are <img>, which neither affects).
		'content-security-policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
		'x-frame-options': 'DENY',
		'cross-origin-resource-policy': 'same-origin',
		'cache-control': 'private, no-store',
		etag
	});
}

/**
 * `GET /files/[id]`: the bytes of a live attachment on a live task or page. Unknown, malformed, deleted and
 * orphaned ids (and a missing R2 object) all get the same 404. `inline` is honoured for PNG, JPEG, GIF and WebP only.
 */
export async function buildDownloadResponse(
	event: RequestEvent,
	idParam: string | undefined,
	options: { inline: boolean }
): Promise<Response> {
	const found = await liveAttachment(event, idParam);
	if (!found || found.row.deletedAt !== null) error(404, FILE_NOT_FOUND);
	const { row } = found;
	const object = await getEnv().FILES.get(row.r2Key);
	if (!object) {
		console.error('attachment_object_missing', { id: row.id });
		error(404, FILE_NOT_FOUND);
	}
	const headers = fileHeaders(row, options.inline, object.httpEtag);
	const ifNoneMatch = event.request.headers.get('if-none-match');
	if (ifNoneMatch?.split(',').some((tag) => tag.trim() === object.httpEtag)) {
		await object.body.cancel();
		return new Response(null, { status: 304, headers });
	}
	headers.set('content-length', String(object.size));
	return new Response(object.body, { headers });
}

/**
 * Delete by the uploader or an admin: tombstone the row first (downloads stop at once), then delete the R2 object.
 * A repeat delete of an already tombstoned row by someone allowed succeeds again and retries the R2 delete; anyone
 * else gets the same 404 as for an unknown id. An R2 failure is logged and still answers success.
 */
export async function deleteAttachment(
	event: RequestEvent,
	user: SessionUser,
	idParam: string | undefined
): Promise<DeleteResult> {
	const found = await liveAttachment(event, idParam);
	if (!found) return { ok: false, code: 'not_found', targetPath: null };
	const { row, targetPath } = found;
	if (!canDeleteAttachment(user, row))
		return row.deletedAt === null
			? { ok: false, code: 'forbidden', targetPath }
			: { ok: false, code: 'not_found', targetPath: null };
	if (row.deletedAt === null) await tombstoneAttachment(event.locals.db, row.id, now());
	try {
		await getEnv().FILES.delete(row.r2Key);
	} catch (e) {
		console.error('attachment_r2_delete_failed', { key: row.r2Key, error: errorLabel(e) });
	}
	return { ok: true, targetPath };
}
