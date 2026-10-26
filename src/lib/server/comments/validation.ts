import { COMMENT_BODY_MAX } from '#lib/shared/comments';
import { cleanBody, isUuid } from '../tasks/validation';

/**
 * Comment input rules (RB-03 PRD › Server modules). Plain functions, as in RB-01 and RB-02: the repo carries no
 * schema library. Bodies are cleaned like task descriptions (cleanBody: NUL and other control characters except tab
 * and newline stripped, CRLF to LF, NFC, trimmed) and counted in code points.
 */
export const COMMENT_LIMITS = {
	bodyMax: COMMENT_BODY_MAX,
	/**
	 * Largest comment form: 10 000 code points are at most 40 000 UTF-8 bytes, 120 000 once URL-encoded, plus a few
	 * short fields.
	 */
	formMaxBytes: 128 * 1024,
	/** Distinct mentioned users one comment (or one edit) notifies; the rest are ignored, the comment is saved. */
	mentionNotifyMax: 20,
	/** `comment-create` budget, shared by create and edit (owner decision 5): per minute and per 10 minutes. */
	perMinute: 20,
	perWindow: 200,
	/** The same body by the same author on the same target within this time is a double submit. */
	duplicateWindowMs: 5_000,
	/** Longest text echoed back into the form after a refusal. */
	echoMax: COMMENT_BODY_MAX * 4
} as const;

export const COMMENT_MESSAGES = {
	empty: 'Write something first.',
	tooLong: `Keep comments to ${COMMENT_BODY_MAX.toLocaleString('en-US')} characters.`,
	throttled: 'You’re commenting too fast, wait a moment.',
	conflict: 'This comment was changed meanwhile, in another tab. Compare and save again.',
	stale: 'This form is out of date. Reload the page and try again.',
	notFound: 'Comment not found.',
	targetGone: 'This item is no longer available.',
	notAuthor: 'Only the author can edit a comment.',
	notAllowed: 'Only the author or an admin can delete a comment.'
} as const;

export type BodyCheck = { ok: true; value: string } | { ok: false; error: string };

/** A comment body as stored, or why it is refused: 1–10 000 code points after cleaning, not whitespace-only. */
export function parseCommentBody(raw: string): BodyCheck {
	// Never cut and then clean: past echoMax UTF-16 units (twice what 10 000 astral characters need) the raw text is
	// refused whole, so padding with characters that cleaning removes cannot make a cut body pass (red team info).
	if (raw.length > COMMENT_LIMITS.echoMax) return { ok: false, error: COMMENT_MESSAGES.tooLong };
	const value = cleanBody(raw);
	if (!value) return { ok: false, error: COMMENT_MESSAGES.empty };
	if (Array.from(value).length > COMMENT_LIMITS.bodyMax)
		return { ok: false, error: COMMENT_MESSAGES.tooLong };
	return { ok: true, value };
}

/** A comment id from a form (lower-cased), or null. */
export function parseCommentId(raw: string): string | null {
	return isUuid(raw) ? raw.toLowerCase() : null;
}

/** `?cpage=` as a page number (1 when missing or malformed). */
export function parseCommentPage(raw: string | null | undefined): number {
	return raw && /^[1-9][0-9]{0,4}$/.test(raw) ? Number(raw) : 1;
}
