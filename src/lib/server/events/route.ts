import { error, type RequestEvent } from '@sveltejs/kit';
import { listActiveUsers } from '../auth/users';
import type { SessionUser } from '../auth/session';
import { requireUser } from '../guards';
import { listProjects } from '../projects/repo';
import { isUuid } from '../tasks/validation';
import { getVisibleEvent, type EventDetail, type EventWrite } from './repo';
import { EVENT_MESSAGES, type EventErrors } from './validation';

/**
 * The signed-in user and the live event `params.id` they may see, read fresh, or one 404 for a malformed, missing,
 * deleted or hidden (someone else's private) id: no existence oracle.
 */
export async function eventFromParams(
	event: Pick<RequestEvent, 'locals' | 'params'>
): Promise<{ user: SessionUser; ev: EventDetail }> {
	const user = requireUser(event);
	const id = (event.params as Record<string, string | undefined>).id ?? '';
	if (!isUuid(id)) error(404, EVENT_MESSAGES.notFound);
	const ev = await getVisibleEvent(event.locals.db, user.id, id.toLowerCase());
	if (!ev) error(404, EVENT_MESSAGES.notFound);
	return { user, ev };
}

/** Choices of the event form: active projects and active users. */
export async function formChoices(db: App.Locals['db']) {
	const [projects, users] = await Promise.all([
		listProjects(db, { archived: false }),
		listActiveUsers(db)
	]);
	return {
		projects: projects.map((p) => ({ id: p.id, key: p.key, name: p.name })),
		users: users.map((u) => ({ id: u.id, name: u.name }))
	};
}

/** A refused event write as field errors (or a thrown 403/404). */
export function writeRefusal(result: Exclude<EventWrite, { ok: true }>): {
	status: number;
	errors: EventErrors;
	conflict?: true;
} {
	switch (result.reason) {
		case 'not_found':
			error(404, EVENT_MESSAGES.notFound);
		// eslint-disable-next-line no-fallthrough -- error() throws
		case 'forbidden':
			error(403, EVENT_MESSAGES.notAllowed);
		// eslint-disable-next-line no-fallthrough -- error() throws
		case 'conflict':
			return { status: 409, errors: { form: EVENT_MESSAGES.conflict }, conflict: true };
		case 'project':
			return { status: 400, errors: { projectId: EVENT_MESSAGES.project } };
		case 'attendees':
			return { status: 400, errors: { attendees: EVENT_MESSAGES.attendee } };
		case 'live_limit':
			return { status: 409, errors: { form: EVENT_MESSAGES.liveLimit } };
		case 'daily_limit':
			return { status: 429, errors: { form: EVENT_MESSAGES.dailyLimit } };
	}
}
