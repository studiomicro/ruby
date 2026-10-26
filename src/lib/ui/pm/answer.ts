/** The RB-08 action answer (`{ pm: … }`, see server/pm/route.ts) for one section, read from a page's `form`. */
export interface PmAnswer {
	section: string;
	ok: boolean;
	message: string;
	errors?: Record<string, string>;
	id?: string;
	values?: Record<string, string>;
}

/** The answer when it belongs to `section` (and, when given, to row `id`); otherwise null. */
export function answerFor(form: unknown, section: string, id?: string): PmAnswer | null {
	const pm = (form as { pm?: PmAnswer } | null | undefined)?.pm;
	if (!pm || pm.section !== section) return null;
	if (id !== undefined && pm.id !== id) return null;
	return pm;
}
