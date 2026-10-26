import { MENTION_QUERY_MAX } from '#lib/shared/comments';
import { mentionMarkup } from '#lib/shared/markdown';

/**
 * The mention picker's text handling (pure): finding the `@query` being typed and replacing it with the mention
 * token. The token is the one the server parses (`mentionMarkup` from the Markdown module).
 */

/**
 * The `@` word that ends at `caret`: `start` is the index of the `@`, `query` what follows it (no spaces, brackets
 * or parentheses, at most MENTION_QUERY_MAX characters). Null when the caret is not in one. The `@` must start the
 * text or follow whitespace or an opening bracket, so an e-mail address does not open the picker.
 */
export function mentionQueryAt(
	text: string,
	caret: number
): { start: number; query: string } | null {
	const before = text.slice(Math.max(0, caret - MENTION_QUERY_MAX - 1), caret);
	const m = /(?:^|[\s(])@([^\s@[\]()]*)$/.exec(before);
	if (!m) return null;
	const query = m[1] ?? '';
	if (query.length > MENTION_QUERY_MAX) return null;
	const start = caret - query.length - 1;
	// The look-behind window may have cut the text: an `@` at the window's start must really start a word.
	if (start > 0 && !/[\s(]/.test(text[start - 1] ?? '')) return null;
	return { start, query };
}

/** A display name made safe to put inside the token: no brackets, parentheses or line breaks. */
export const sanitizeMentionName = (name: string) =>
	name.replace(/[[\]()\r\n]/g, '').trim() || 'user';

/** `text` with `text[start, caret)` (the `@query`) replaced by the mention of `user` and a space; the new caret. */
export function insertMention(
	text: string,
	start: number,
	caret: number,
	user: { id: string; name: string }
): { text: string; caret: number } {
	const token = `${mentionMarkup({ id: user.id, name: sanitizeMentionName(user.name) })} `;
	return { text: text.slice(0, start) + token + text.slice(caret), caret: start + token.length };
}
