import { error, fail } from '@sveltejs/kit';
import { MESSAGES } from '../tasks/validation';
import type { PmRefusal } from './common';

/**
 * The answer shape of every RB-08 form action: `{ pm: { section, ok, message, errors?, id? } }`, so a page with
 * several RB-08 forms shows each answer next to the form it belongs to (`section`, plus `id` for one row of a
 * list). Success carries the message shown only after the server confirmed the write.
 */
/** The answer to a manager-only write by someone who is not (or no longer) a manager. */
export const NOT_ALLOWED =
	'Only the project lead, its creator or an admin can change this project.';

export interface PmAnswer {
	section: string;
	ok: boolean;
	message: string;
	errors?: Record<string, string>;
	/** The row (label, milestone, step, view) the answer is about. */
	id?: string;
	/** What the user typed, so a refused no-JS form keeps it. */
	values?: Record<string, string>;
}

export const pmOk = (section: string, message: string, id?: string) => ({
	pm: { section, ok: true, message, ...(id ? { id } : {}) } satisfies PmAnswer
});

export const pmInvalid = (
	section: string,
	message: string,
	options: { errors?: Record<string, string>; id?: string; values?: Record<string, string> } = {}
) => fail(400, { pm: { section, ok: false, message, ...options } satisfies PmAnswer });

/**
 * A refused write as the action's answer. A plain `not_found` (the project, task or row from the URL or form is
 * gone, hidden or someone else's) is `error(404, notFound)`: one answer for all of them. One that names a message
 * (a step or tasks deleted meanwhile) is a 404 answer the form shows.
 */
export function pmRefused(
	section: string,
	result: PmRefusal,
	notFound: string,
	options: { id?: string; values?: Record<string, string> } = {}
) {
	const answer = (status: number, message: string) =>
		fail(status, {
			pm: {
				section,
				ok: false,
				message,
				...(result.errors ? { errors: result.errors } : {}),
				...options
			} satisfies PmAnswer
		});
	switch (result.reason) {
		case 'forbidden':
			error(403, NOT_ALLOWED);
		// falls through: error() throws
		case 'not_found':
			if (!result.message) error(404, notFound);
			return answer(404, result.message);
		case 'archived':
			return answer(409, MESSAGES.archived);
		case 'conflict':
			return answer(409, result.message ?? MESSAGES.stale);
		default:
			return answer(400, result.message ?? MESSAGES.stale);
	}
}
