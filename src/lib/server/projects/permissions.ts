import type { SessionUser } from '../auth/session';

/**
 * Owner decision 1: every active user may create projects and tasks and edit any task. Editing or archiving a
 * project is for its lead, its creator or an admin; soft-deleting a task is for the task's creator, the project's
 * lead or an admin. Routes check these against a fresh read of the row, never against ids from the form.
 */
type Actor = Pick<SessionUser, 'id' | 'role'>;
type ProjectRef = { leadId: string | null; createdBy: string };

export function canManageProject(actor: Actor, project: ProjectRef): boolean {
	return actor.role === 'admin' || actor.id === project.leadId || actor.id === project.createdBy;
}

export function canDeleteTask(
	actor: Actor,
	project: ProjectRef,
	task: { createdBy: string }
): boolean {
	return actor.role === 'admin' || actor.id === project.leadId || actor.id === task.createdBy;
}
