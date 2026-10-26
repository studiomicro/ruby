/** Letters and digits of a word (any script), so "Anne-Marie" reads as "AnneMarie". */
const wordChars = (word: string) => Array.from(word).filter((c) => /[\p{L}\p{N}]/u.test(c));

/**
 * Up to two upper-case initials: the first character of the first and last words ("Dewi Ayu Lestari" → "DL"), else
 * the first character of the one word ("Budi" → "B"); "?" when the name has no letter or digit.
 */
export function initials(name: string): string {
	const words = name
		.split(/\s+/)
		.map(wordChars)
		.filter((w) => w.length > 0);
	const first = words[0]?.[0] ?? '';
	const last = words.length > 1 ? (words.at(-1)?.[0] ?? '') : '';
	const picked = first + last;
	return picked ? picked.toLocaleUpperCase('en') : '?';
}

/** Number of Avatar tint classes (`tint-0` … `tint-5`). */
export const AVATAR_TINTS = 6;

/** The tint slot of `seed` (a user id): FNV-1a, so one person always has the same colour. */
export function avatarTint(seed: string): number {
	let hash = 0x811c9dc5;
	for (const c of seed) {
		hash ^= c.codePointAt(0) as number;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash % AVATAR_TINTS;
}
