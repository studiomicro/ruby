import { ATTACHMENT_LIMITS } from '#lib/shared/attachments';

/**
 * Control (Cc), format (Cf: zero-width, bidi overrides and isolates, BOM, soft hyphen), unpaired surrogates (Cs),
 * line and paragraph separators, every default-ignorable code point (Hangul fillers U+115F, U+1160, U+3164,
 * U+FFA0, the Mongolian vowel separator U+180E, variation selectors …) and the blank Braille pattern U+2800. A bidi
 * override would let `a<U+202E>gnp.exe` display as `aexe.png`; a run of blank-looking letters would push a real
 * extension out of sight (`invoice.pdf<60 × U+3164>.exe`).
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/gu;
/** Whitespace that separates words (not the invisible U+FEFF that `\s` also matches). */
const SPACES = /[\t\n\v\f\r\p{Zs}]+/gu;
/** Path and shell-special characters no file system agrees on. */
const PATH_CHARS = /[/\\:*?"<>|]/g;
/** Windows device names: `CON.txt` opens the console on Windows, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_EXTENSION = 16;

/** The extension a name ends in (`pdf`), lower case, or '' when it has none (shown apart from the name). */
export function fileExtension(name: string): string {
	const dot = name.lastIndexOf('.');
	const ext = dot > 0 ? name.slice(dot + 1) : '';
	return ext.length > 0 && Array.from(ext).length <= MAX_EXTENSION ? ext.toLowerCase() : '';
}

const trimEdges = (s: string) => s.replace(/^[\s.]+|[\s.]+$/g, '');

/**
 * The name an uploaded file is stored and shown under (PRD RB-04 › filename.ts): NFC; path characters, controls,
 * zero-width and bidi characters removed; whitespace collapsed; leading and trailing dots and spaces trimmed; cut
 * to 120 code points keeping an extension of up to 16; `file` when nothing is left; device names get a `_` prefix.
 * The original name is never stored.
 */
export function cleanFilename(raw: string): string {
	const max = ATTACHMENT_LIMITS.maxFilenameChars;
	// Cap the work before any regex: a name longer than this is cut anyway.
	const capped = raw.slice(0, max * 8);
	let name = trimEdges(
		capped
			.normalize('NFC')
			// Tabs, line breaks and space separators become one space first, so "a\tb" stays two words.
			.replace(SPACES, ' ')
			.replace(INVISIBLE, '')
			.replace(PATH_CHARS, '')
			.replace(SPACES, ' ')
	);
	const chars = Array.from(name);
	if (chars.length > max) {
		const dot = name.lastIndexOf('.');
		const ext = dot > 0 ? name.slice(dot) : '';
		const extChars = Array.from(ext);
		const keep = extChars.length > 1 && extChars.length <= MAX_EXTENSION + 1 ? ext : '';
		const stemMax = max - Array.from(keep).length;
		name = trimEdges(chars.slice(0, stemMax).join('')) + keep;
		name = trimEdges(Array.from(name).slice(0, max).join(''));
	}
	if (!name) return 'file';
	const stem = name.split('.', 1)[0] ?? '';
	return RESERVED.test(stem.trim()) ? `_${name}` : name;
}
