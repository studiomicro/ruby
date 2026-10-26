import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import type { CommentFormResult } from '#lib/shared/comments';
import { readFormBody, textField } from '../forms';
import { requireUser } from '../guards';
import { parseExpected } from '../tasks/validation';
import { now } from '../util';
import {
	commentPosition,
	createComment,
	deleteComment,
	editComment,
	pageOfPosition,
	type CommentTarget
} from './service';
import {
	COMMENT_LIMITS,
	COMMENT_MESSAGES,
	parseCommentBody,
	parseCommentId,
	parseCommentPage
} from './validation';

/**
 * The three comment form actions of a host page (task detail, KB page): `?/commentCreate`, `?/commentEdit`,
 * `?/commentDelete`. Each starts with requireUser, reads the host's live target fresh through `host` (which answers
 * the host's own 404 for a missing or deleted task or page), and calls the service. A refusal comes back under the
 * `comment` key (CommentFormResult) with the typed text, so it never collides with the host's form data; success
 * redirects to the comment (`#comment-<id>`, on its thread page), which works the same with and without JavaScript.
 */
export interface HostTarget extends CommentTarget {
	/** The host page's path, which the redirect goes back to. */
	href: string;
}

const refuse = (status: number, comment: CommentFormResult) => fail(status, { comment });
const echo = (raw: string) => raw.slice(0, COMMENT_LIMITS.echoMax);

/** Redirects to comment `id` on its thread page; a failed position read falls back to page 1 (the write is done). */
async function toComment(db: App.Locals['db'], host: HostTarget, id: string): Promise<never> {
	const page = pageOfPosition(await commentPosition(db, id).catch(() => 0));
	redirect(303, `${host.href}${page > 1 ? `?cpage=${page}` : ''}#comment-${id}`);
}

export function commentActions<E extends RequestEvent>(host: (event: E) => Promise<HostTarget>) {
	return {
		commentCreate: async (event: E) => {
			const user = requireUser(event);
			const target = await host(event);
			const form = await readFormBody(event.request, COMMENT_LIMITS.formMaxBytes);
			const raw = textField(form, 'body');
			const body = parseCommentBody(raw);
			if (!body.ok) return refuse(400, { action: 'create', error: body.error, body: echo(raw) });
			const db = event.locals.db;
			const result = await createComment(db, user, target, body.value, now());
			if (result.ok) return toComment(db, target, result.id);
			if (result.reason === 'throttled')
				return refuse(429, {
					action: 'create',
					error: COMMENT_MESSAGES.throttled,
					body: echo(raw)
				});
			error(404, COMMENT_MESSAGES.targetGone);
		},

		commentEdit: async (event: E) => {
			const user = requireUser(event);
			const target = await host(event);
			const form = await readFormBody(event.request, COMMENT_LIMITS.formMaxBytes);
			const id = parseCommentId(textField(form, 'commentId'));
			if (!id) error(404, COMMENT_MESSAGES.notFound);
			const raw = textField(form, 'body');
			const expected = parseExpected(textField(form, 'expectedUpdatedAt'));
			if (expected === null)
				return refuse(400, { action: 'edit', id, error: COMMENT_MESSAGES.stale, body: echo(raw) });
			const body = parseCommentBody(raw);
			if (!body.ok) return refuse(400, { action: 'edit', id, error: body.error, body: echo(raw) });
			const db = event.locals.db;
			const result = await editComment(db, user, target, id, body.value, expected, now());
			if (result.ok) return toComment(db, target, id);
			switch (result.reason) {
				case 'throttled':
					return refuse(429, {
						action: 'edit',
						id,
						error: COMMENT_MESSAGES.throttled,
						body: echo(raw)
					});
				case 'conflict':
					return refuse(409, {
						action: 'edit',
						id,
						error: COMMENT_MESSAGES.conflict,
						body: echo(raw),
						current: result.body,
						expectedUpdatedAt: result.updatedAt
					});
				case 'forbidden':
					error(403, COMMENT_MESSAGES.notAuthor);
				// falls through: error() throws
				default:
					error(404, COMMENT_MESSAGES.notFound);
			}
		},

		commentDelete: async (event: E) => {
			const user = requireUser(event);
			const target = await host(event);
			const form = await readFormBody(event.request);
			const id = parseCommentId(textField(form, 'commentId'));
			if (!id) error(404, COMMENT_MESSAGES.notFound);
			const result = await deleteComment(event.locals.db, user, target, id, now());
			// Back to the thread page the form was on (loadThread clamps it if that page is now empty).
			const page = parseCommentPage(textField(form, 'cpage'));
			if (result.ok) redirect(303, `${target.href}${page > 1 ? `?cpage=${page}` : ''}#comments`);
			if (result.reason === 'forbidden') error(403, COMMENT_MESSAGES.notAllowed);
			error(404, COMMENT_MESSAGES.notFound);
		}
	};
}
