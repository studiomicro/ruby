/** Longest return target (`next`) kept; anything longer goes to "/". */
export const RETURN_TO_MAX_LENGTH = 2000;
/** Percent-decoded forms checked; a value that still decodes after this many is refused. */
const RETURN_TO_DECODE_ROUNDS = 3;
/**
 * C0 controls, DEL and backslash. URL parsers drop TAB, LF and CR wherever they are, so
 * `/<TAB>/evil.test` is followed as `//evil.test`; a backslash counts as a slash in http(s) URLs.
 */
// eslint-disable-next-line no-control-regex -- intentional: refuses control characters in a redirect target
const UNSAFE_CHAR = /[\u0000-\u001f\u007f\\]/;
/** Placeholder origin (reserved `.invalid` TLD) to resolve against; only the path is returned. */
const BASE = 'http://ruby.invalid';

/** One round of percent-decoding that never throws (a stray `%` is kept). */
const percentDecodeOnce = (s: string) =>
	s.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** `s` and every percent-decoded form of it is a bounded path on this origin. */
function isLocalPath(s: string): boolean {
	if (s.length > RETURN_TO_MAX_LENGTH) return false;
	for (let round = 0; round <= RETURN_TO_DECODE_ROUNDS; round++) {
		if (!s.startsWith('/') || s.startsWith('//') || UNSAFE_CHAR.test(s)) return false;
		const decoded = percentDecodeOnce(s);
		if (decoded === s) return true;
		s = decoded;
	}
	return false;
}

/**
 * The post-sign-in redirect target: `value` when it is a path on this site, else `/`: checked, resolved as a URL that must stay on the same origin, and only that URL's own path,
 * query and hash returned, checked once more (dot segments can normalise `/.//evil.test` into `//evil.test`).
 */
export function safeReturnTo(value: string | null | undefined): string {
	if (!value || !isLocalPath(value)) return '/';
	const url = new URL(value, BASE);
	if (url.origin !== BASE) return '/';
	const path = url.pathname + url.search + url.hash;
	return isLocalPath(path) ? path : '/';
}
