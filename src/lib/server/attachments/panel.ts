import type { SessionUser } from '../auth/session';
import type { Db } from '../db';
import { INLINE_TYPES } from './content-type';
import { fileExtension } from './filename';
import { canDeleteAttachment } from './permissions';
import { listAttachments } from './repo';
import {
	ATTACHMENT_ERROR_MESSAGES,
	ATTACHMENT_LIMITS,
	attachmentError,
	type AttachmentPanelData
} from '#lib/shared/attachments';
import type { TargetKind } from '#lib/shared/enums';

function flashFrom(url: URL): AttachmentPanelData['flash'] {
	const q = url.searchParams;
	if (q.get('uploaded') === '1') return { tone: 'success', message: 'File uploaded.' };
	if (q.get('deleted') === '1') return { tone: 'success', message: 'File deleted.' };
	const code = attachmentError(q.get('upload_error') ?? q.get('delete_error'));
	return code ? { tone: 'error', message: ATTACHMENT_ERROR_MESSAGES[code] } : null;
}

/** The panel's data for a live task or page the host page already loaded. */
export async function attachmentPanel(
	db: Db,
	user: SessionUser,
	targetKind: TargetKind,
	targetId: string,
	url: URL
): Promise<AttachmentPanelData> {
	const rows = await listAttachments(db, targetKind, targetId);
	return {
		targetKind,
		targetId,
		returnTo: url.pathname,
		items: rows.map((r) => ({
			id: r.id,
			filename: r.filename,
			extension: fileExtension(r.filename),
			sizeBytes: r.sizeBytes,
			image: INLINE_TYPES.has(r.contentType),
			uploaderName: r.uploaderName,
			createdAt: r.createdAt,
			canDelete: canDeleteAttachment(user, r)
		})),
		max: ATTACHMENT_LIMITS.maxPerTarget,
		maxBytes: ATTACHMENT_LIMITS.maxBytes,
		flash: flashFrom(url)
	};
}
