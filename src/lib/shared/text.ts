/**
 * Control (Cc), format (Cf: zero-width, bidi overrides, soft hyphen) and line/paragraph separators.
 * Removed from untrusted text before storage (checklist › Untrusted text and Markdown).
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Untrusted single-line text (a title, a name) made safe to store: capped to `max * 4` UTF-16 units before any work
 * (so a huge input costs nothing), invisible characters stripped, NFC-normalised, whitespace collapsed and trimmed,
 * then cut to `max` code points. Multi-line Markdown bodies are not single-line text: do not pass them here.
 */
export function cleanText(input: string, max: number): string {
	const capped = input.slice(0, max * 4);
	// Whitespace (tabs and newlines included) becomes one space first, so "a\tb" stays two words.
	const visible = capped
		.replace(/\s+/g, ' ')
		.replace(INVISIBLE, '')
		.normalize('NFC')
		.replace(/\s+/g, ' ')
		.trim();
	return Array.from(visible).slice(0, max).join('').trim();
}
