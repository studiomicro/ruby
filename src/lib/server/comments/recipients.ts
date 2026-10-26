import type { NotificationKind } from '#lib/shared/enums';
import { COMMENT_LIMITS } from './validation';

export type CommentNotificationKind = Extract<NotificationKind, 'mention' | 'comment'>;

export interface RecipientInput {
	/** Ids the body mentions, in order of appearance (extractMentionIds: lower-cased, de-duplicated). */
	mentionIds: readonly string[];
	/** Which of the candidate ids (mentions, assignee, creator) are active users right now. */
	activeIds: ReadonlySet<string>;
	/** A task's assignee and creator: they hear of a new comment. Absent for pages and for edits. */
	assigneeId?: string | null;
	creatorId?: string | null;
	authorId: string;
	/** Users already told about this comment (an edit: everyone the old body mentioned). */
	alreadyNotified?: ReadonlySet<string>;
}

/**
 * Who hears about a comment, and how (RB-03 PRD › Rules). Mentioned active users get `mention`, at most
 * COMMENT_LIMITS.mentionNotifyMax of them in order of appearance; then a task's assignee and creator get `comment`
 * unless already mentioned (mention wins; one notification per user per comment). The author, disabled and
 * unknown users never get one, nor does anyone in `alreadyNotified`. Pure.
 */
export function computeRecipients(input: RecipientInput): Map<string, CommentNotificationKind> {
	const out = new Map<string, CommentNotificationKind>();
	const eligible = (id: string | null | undefined): id is string =>
		!!id &&
		id !== input.authorId &&
		input.activeIds.has(id) &&
		!out.has(id) &&
		!input.alreadyNotified?.has(id);
	let mentioned = 0;
	for (const raw of input.mentionIds) {
		if (mentioned >= COMMENT_LIMITS.mentionNotifyMax) break;
		const id = raw.toLowerCase();
		if (!eligible(id)) continue;
		out.set(id, 'mention');
		mentioned += 1;
	}
	for (const raw of [input.assigneeId, input.creatorId]) {
		const id = raw?.toLowerCase();
		if (eligible(id)) out.set(id, 'comment');
	}
	return out;
}
