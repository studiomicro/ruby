import { cleanText } from '#lib/shared/text';

/**
 * Knowledge-base input rules (RB-02 PRD › Validation). Plain functions rather than a schema library: the repo has
 * none, and each rule is a line or two. Every route reads its form through these, and the repo re-checks nothing
 * the database itself guards (parent, scope and cycle rules live in the SQL).
 */
export const KB_LIMITS = {
	titleMax: 200,
	bodyMax: 200_000,
	/** Root pages are depth 1; no page sits deeper than this. */
	maxDepth: 8,
	/** Most pages one scope's tree loads; past it the tree shows three levels with "Show more" links. */
	scopeRowsMax: 2000,
	/** Children listed under a page. */
	childrenMax: 200,
	historyPageSize: 50,
	/**
	 * Largest editor form body: a 200,000-character body (code points) is at most 800 KB as UTF-8 (the editor posts
	 * multipart/form-data, which does not percent-encode), plus the title and a few short fields.
	 */
	formMaxBytes: 1024 * 1024
} as const;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION_RE = /^[1-9][0-9]{0,8}$/;
/** A project key in a URL or form (RB-01 keys are short letters and digits, `OPS`). */
const PROJECT_KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,9}$/;

export const isUuid = (value: string): boolean => UUID_RE.test(value);

/** Characters as a person counts them: code points (a surrogate pair is one; a lone surrogate counts as one). */
function codePoints(value: string): number {
	let n = 0;
	for (let i = 0; i < value.length; i += (value.codePointAt(i) ?? 0) > 0xffff ? 2 : 1) n++;
	return n;
}

/** A positive revision (or page) number from a URL or form, or null for anything else (0, `abc`, `1e3`, 10 digits). */
export function parseRevision(value: string | null | undefined): number | null {
	return value && REVISION_RE.test(value) ? Number(value) : null;
}

/** A project key from a URL or form, upper-cased, or null when it cannot be a key. */
export function parseProjectKey(value: string | null | undefined): string | null {
	return value && PROJECT_KEY_RE.test(value) ? value.toUpperCase() : null;
}

export const TITLE_REQUIRED = 'Give the page a title.';
export const TITLE_TOO_LONG = `Keep the title to ${KB_LIMITS.titleMax} characters.`;
export const BODY_TOO_LONG = `Keep the page under ${KB_LIMITS.bodyMax.toLocaleString('en-US')} characters.`;

/**
 * A page title made safe to store: control, zero-width and bidi characters stripped, newlines and runs of spaces
 * collapsed to one space, trimmed (cleanText). One character more than the limit is kept so an over-long title is
 * refused, not silently cut.
 */
export function checkTitle(raw: string): { value: string; error?: string } {
	const value = cleanText(raw, KB_LIMITS.titleMax + 1);
	if (!value) return { value, error: TITLE_REQUIRED };
	if (Array.from(value).length > KB_LIMITS.titleMax) return { value, error: TITLE_TOO_LONG };
	return { value };
}

/**
 * A page body (Markdown) made safe to store: NUL and the 0x01/0x02 bytes search uses as highlight markers are
 * removed, and `\r\n` (or a lone `\r`) becomes `\n`. Nothing else changes: it is Markdown, not single-line text.
 */
export function checkBody(raw: string): { value: string; error?: string } {
	// eslint-disable-next-line no-control-regex -- intentional: NUL and the snippet markers are removed
	const value = raw.replace(/[\u0000\u0001\u0002]/g, '').replace(/\r\n?/g, '\n');
	// Code points, like the title (an emoji is one character). UTF-16 length is an upper bound, so most bodies skip the count.
	if (value.length > KB_LIMITS.bodyMax && codePoints(value) > KB_LIMITS.bodyMax)
		return { value, error: BODY_TOO_LONG };
	return { value };
}

/** Where a moved page goes among its new siblings. */
export type Placement = { kind: 'first' } | { kind: 'last' } | { kind: 'after'; siblingId: string };

/** `first`, `last` (also for an empty field) or `after:<page id>`; null for anything else. */
export function parsePlacement(raw: string): Placement | null {
	if (raw === '' || raw === 'last') return { kind: 'last' };
	if (raw === 'first') return { kind: 'first' };
	const sibling = raw.startsWith('after:') ? raw.slice(6) : '';
	return isUuid(sibling) ? { kind: 'after', siblingId: sibling.toLowerCase() } : null;
}

/** A parent field: '' is the top level of the scope; otherwise a page id. `undefined` marks an invalid value. */
export function parseParentId(raw: string): string | null | undefined {
	if (raw === '') return null;
	return isUuid(raw) ? raw.toLowerCase() : undefined;
}
