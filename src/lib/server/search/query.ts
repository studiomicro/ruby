/**
 * Turning untrusted search text into a safe FTS5 MATCH expression, and SQL snippets into text segments (RB-02 PRD ›
 * Search). Pure; the one place user text meets FTS5 syntax.
 *
 * Every token is emitted as an FTS5 string (`"token"`), followed by `*` (prefix match) when it is two characters
 * or longer, joined by spaces (implicit AND). A one-character token matches that exact term only: as a prefix it
 * would scan every index term starting with that letter. Splitting on everything that is not a letter or digit leaves no quote, operator, column filter (`a:b`),
 * `^`, `-`, `+`, `*` or parenthesis in a token, and a bare word such as `NEAR`, `AND` or `OR` is inert inside
 * quotes; quotes are still doubled defensively.
 */

export const SEARCH_LIMITS = {
	/** Characters of the query kept (longer input is cut, not refused). */
	inputMax: 200,
	/** A token longer than this is dropped (no word is this long; it is noise or an attack). */
	tokenMax: 64,
	/** At most this many tokens are searched for. */
	tokensMax: 8
} as const;

/** The query as the user meant it: trimmed, NFKC-normalised, at most SEARCH_LIMITS.inputMax characters. */
export function normaliseQuery(raw: string): string {
	// Cut before normalising so a huge input costs nothing; NFKC can grow text, so cut again after.
	const head = raw.slice(0, SEARCH_LIMITS.inputMax * 4).normalize('NFKC');
	return Array.from(head).slice(0, SEARCH_LIMITS.inputMax).join('').trim();
}

/** Lower-cased letter-and-digit runs (mirrors FTS5's unicode61 tokenizer), each 1–64 characters, at most 8. */
export function queryTokens(raw: string): string[] {
	return normaliseQuery(raw)
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 0 && Array.from(t).length <= SEARCH_LIMITS.tokenMax)
		.slice(0, SEARCH_LIMITS.tokensMax);
}

/** The MATCH expression for `raw`, or null when it holds no letter or digit (no query is run then). */
export function buildMatchQuery(raw: string): string | null {
	const tokens = queryTokens(raw);
	if (tokens.length === 0) return null;
	return tokens
		.map((t) => `"${t.replaceAll('"', '""')}"${Array.from(t).length > 1 ? '*' : ''}`)
		.join(' ');
}

/** Where a highlight starts and ends in SQL `snippet()`/`highlight()` output (`char(1)`, `char(2)`). */
export const HIT_START = '\u0001';
export const HIT_END = '\u0002';

export interface Segment {
	text: string;
	hit: boolean;
}

/**
 * `snippet()` output split at the markers into text segments; `hit` segments get a <mark> in the template, which
 * renders every segment as a text node (no {@html}). The markers never reach the text; a stray end marker is
 * dropped and an unclosed hit ends with the string. Empty segments are left out, neighbours of one kind merged.
 */
export function splitMarkedSnippet(s: string): Segment[] {
	const out: Segment[] = [];
	let hit = false;
	let text = '';
	const flush = () => {
		if (!text) return;
		const last = out[out.length - 1];
		if (last && last.hit === hit) last.text += text;
		else out.push({ text, hit });
		text = '';
	};
	for (const ch of s) {
		if (ch === HIT_START || ch === HIT_END) {
			flush();
			hit = ch === HIT_START;
		} else text += ch;
	}
	flush();
	return out;
}

/** A task identifier such as `OPS-12`: shown first as "Exact match" when that task exists. */
const TASK_REF_RE = /^([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]{0,8})$/;

export function parseTaskRef(q: string): { key: string; number: number } | null {
	const m = TASK_REF_RE.exec(q);
	return m ? { key: (m[1] as string).toUpperCase(), number: Number(m[2]) } : null;
}

export const SEARCH_TYPES = ['all', 'pages', 'tasks'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** `all`, `pages` or `tasks`; anything else falls back to `all`. */
export const parseSearchType = (raw: string | null): SearchType =>
	(SEARCH_TYPES as readonly string[]).includes(raw ?? '') ? (raw as SearchType) : 'all';
