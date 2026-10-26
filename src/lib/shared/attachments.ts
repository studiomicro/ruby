import type { TargetKind } from './enums';

/**
 * RB-04 attachment limits, error codes and the words the panel shows for them. Shared because the upload panel
 * checks a file's size and the per-item count before sending it (a convenience: the server decides).
 */
export const ATTACHMENT_LIMITS = {
	/** 25 MB (owner decision 2026-10-26). */
	maxBytes: 26_214_400,
	/** Live (not deleted) attachments per task or page. */
	maxPerTarget: 20,
	/** Longest stored file name, in code points. */
	maxFilenameChars: 120,
	/** What a multipart body may carry beyond the file itself (boundaries, part headers, the other fields). */
	bodyOverheadBytes: 1_048_576
} as const;

export const ATTACHMENT_ERRORS = [
	'too_large',
	'empty',
	'limit',
	'target_gone',
	'bad_request',
	'throttled',
	'storage',
	'forbidden',
	'not_found',
	'signed_out'
] as const;
export type AttachmentError = (typeof ATTACHMENT_ERRORS)[number];

export const ATTACHMENT_ERROR_MESSAGES: Record<AttachmentError, string> = {
	too_large: 'File is larger than 25 MB',
	empty: 'File is empty',
	limit: `This item already has ${ATTACHMENT_LIMITS.maxPerTarget} attachments`,
	target_gone: 'This item no longer exists',
	bad_request: 'Upload failed, try again',
	throttled: 'You’re uploading too fast, wait a moment',
	storage: 'Upload failed, try again',
	forbidden: 'Only the uploader or an admin can delete this file',
	not_found: 'That file no longer exists',
	signed_out: 'Your session has ended, sign in again'
};

/** The error code `value` names, or null (a flash parameter from the URL is never shown as given). */
export const attachmentError = (value: string | null | undefined): AttachmentError | null =>
	(ATTACHMENT_ERRORS as readonly string[]).includes(value ?? '')
		? (value as AttachmentError)
		: null;

/** A byte count as people read it: `512 B`, `3.4 KB`, `25 MB` (1 KB = 1024 bytes). */
export function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB'] as const;
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const shown = value >= 10 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '');
	return `${shown} ${units[unit]}`;
}

/** What the host page passes to `<AttachmentPanel>`: never an R2 key. */
export interface AttachmentPanelData {
	targetKind: TargetKind;
	targetId: string;
	/** The page the forms come back to (the host page's own path). */
	returnTo: string;
	items: {
		id: string;
		filename: string;
		/** The real extension, shown apart from the (possibly cut) name; '' when there is none. */
		extension: string;
		sizeBytes: number;
		image: boolean;
		uploaderName: string;
		createdAt: number;
		/** Display only: the delete route decides. */
		canDelete: boolean;
	}[];
	max: number;
	maxBytes: number;
	/** The result of the last no-JS upload or delete, from the redirect's flash parameter. */
	flash: { tone: 'success' | 'error'; message: string } | null;
}
