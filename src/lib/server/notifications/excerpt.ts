import { UNKNOWN_USER } from '#lib/shared/markdown';
import { cleanText } from '#lib/shared/text';

/** Characters of a comment a notification row shows. */
export const EXCERPT_MAX = 140;

const MENTION =
	/@\[[^[\]\n\r]{1,80}\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

/**
 * The first EXCERPT_MAX characters of a comment as plain text, for a notification row (rendered as text, never
 * HTML). Mentions show the mentioned user's current name from `names` (never the label the author typed; RB-00 L6);
 * link and image syntax keeps only its text; code fences, heading, quote and list markers and emphasis marks go;
 * whitespace collapses (cleanText also strips control and zero-width characters). Longer text ends in `…`. Pure.
 */
export function commentExcerpt(body: string, names: ReadonlyMap<string, string>): string {
	const text = body
		.slice(0, EXCERPT_MAX * 20)
		.replace(MENTION, (_, id: string) => `@${names.get(id.toLowerCase()) ?? UNKNOWN_USER}`)
		.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
		.replace(/^\s*(```|~~~).*$/gm, ' ')
		.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d{1,9}[.)]\s+)/gm, '')
		.replace(/\*\*|__|~~|[*`]/g, '');
	const clean = cleanText(text, EXCERPT_MAX + 1);
	const chars = Array.from(clean);
	return chars.length > EXCERPT_MAX ? `${chars.slice(0, EXCERPT_MAX).join('').trimEnd()}…` : clean;
}
