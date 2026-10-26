import type { TargetKind } from './enums';

/**
 * RB-03 values the server and the comment UI share (the form's counter and `maxlength` mirror the server rule; the
 * server is the rule). Pure, no imports beyond types.
 */

/** Most characters (code points) of a comment body. */
export const COMMENT_BODY_MAX = 10_000;
/** Comments a thread shows per page (`?cpage=`). */
export const COMMENT_PAGE_SIZE = 100;
/** Longest `q` the mention picker may send (`/api/mentions`). */
export const MENTION_QUERY_MAX = 50;

/** One comment as a thread shows it. */
export interface CommentView {
	id: string;
	authorId: string;
	authorName: string;
	body: string;
	createdAt: number;
	updatedAt: number;
	edited: boolean;
	canEdit: boolean;
	canDelete: boolean;
}

/** What a host page's loader hands to `CommentThread` (under its `comments` key). */
export interface ThreadData {
	target: { kind: TargetKind; id: string };
	comments: CommentView[];
	/** id → current display name for every mention in the bodies shown (RB-00 L6). */
	names: Map<string, string>;
	page: number;
	pageCount: number;
	total: number;
	/** The viewer's own comment opened for editing (`?cedit=<id>`), when it is on this page. */
	editingId: string | null;
}

/** The `comment` key of a comment action's refusal (kept apart from the host page's own form keys). */
export interface CommentFormResult {
	action: 'create' | 'edit' | 'delete';
	/** The comment an edit or delete was for. */
	id?: string;
	error: string;
	/** What the person typed, so a refusal never loses it. */
	body?: string;
	/** Edit conflict: the stored version to compare with, and the version to retry against. */
	current?: string;
	expectedUpdatedAt?: number;
}
