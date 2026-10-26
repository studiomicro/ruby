import { error, type RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from '../auth/session';
import { requireUser } from '../guards';
import { getProjectByKey, type Project } from './repo';
import { KEY_RE } from './validation';

/** One answer for an unknown, deleted or malformed project or task: no existence oracle. */
export const PROJECT_NOT_FOUND = 'Project not found.';
export const TASK_NOT_FOUND = 'Task not found.';

/**
 * The signed-in user and the live project named by `params.key` (already upper case: the project layout sends
 * other spellings to it), or a 404. Every RB-01 load and action under /projects/[key] starts here, so the project
 * (and its archive state) is always read fresh on the server.
 */
export async function projectFromParams(
	event: Pick<RequestEvent, 'locals' | 'params'>
): Promise<{ user: SessionUser; project: Project }> {
	const user = requireUser(event);
	const key = (event.params as Record<string, string | undefined>).key ?? '';
	if (!KEY_RE.test(key)) error(404, PROJECT_NOT_FOUND);
	const project = await getProjectByKey(event.locals.db, key);
	if (!project) error(404, PROJECT_NOT_FOUND);
	return { user, project };
}

/** `params.number` as a task number (`^[1-9][0-9]{0,8}$`), or a 404. */
export function taskNumberParam(raw: string | undefined): number {
	if (!raw || !/^[1-9][0-9]{0,8}$/.test(raw)) error(404, TASK_NOT_FOUND);
	return Number(raw);
}
