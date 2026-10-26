import { eq, sql } from 'drizzle-orm';
import type { SessionUser } from '#lib/server/auth/session';
import type { Db } from '#lib/server/db';
import { notifications, projects, tasks } from '#lib/server/db/schema';
import { createProject, getProjectByKey, type Project } from '#lib/server/projects/repo';
import { createTask } from '#lib/server/tasks/repo';
import type { TaskFields } from '#lib/server/tasks/validation';

/** RB-01 fixtures: fictional projects and tasks written through the real repo functions. */

let keyCounter = 0;
/** A fresh, unique project key (`T1`, `T2` …, then letters), for tests sharing one database. */
export const nextKey = () => `T${(keyCounter += 1)}${String.fromCharCode(65 + (keyCounter % 26))}`;

export async function seedProject(
	db: Db,
	actor: SessionUser,
	options: { key?: string; name?: string; leadId?: string | null } = {},
	at = Date.now()
): Promise<Project> {
	const key = options.key ?? nextKey();
	const created = await createProject(
		db,
		actor,
		{
			key,
			name: options.name ?? `Project ${key}`,
			description: '',
			leadId: options.leadId ?? null
		},
		at
	);
	if (!created.ok) throw new Error(`seedProject failed: ${created.reason}`);
	const project = await getProjectByKey(db, key);
	if (!project) throw new Error('seedProject: not found after create');
	return project;
}

export const taskDefaults = (overrides: Partial<TaskFields> = {}): TaskFields => ({
	title: 'Fictional task',
	description: '',
	status: 'todo',
	priority: 'none',
	assigneeId: null,
	dueOn: null,
	milestoneId: null,
	...overrides
});

export async function seedTask(
	db: Db,
	actor: SessionUser,
	project: { id: string },
	overrides: Partial<TaskFields> = {},
	at = Date.now()
): Promise<{ id: string; number: number }> {
	const created = await createTask(db, actor, project, taskDefaults(overrides), at);
	if (!created.ok) throw new Error(`seedTask failed: ${created.reason}`);
	return { id: created.id, number: created.number };
}

export async function archive(db: Db, projectId: string) {
	await db.update(projects).set({ status: 'archived' }).where(eq(projects.id, projectId));
}

export async function taskRow(db: Db, id: string) {
	return db.select().from(tasks).where(eq(tasks.id, id)).get();
}

export async function assignedNotifications(db: Db, userId?: string) {
	const rows = await db.select().from(notifications).where(eq(notifications.kind, 'assigned'));
	return userId ? rows.filter((r) => r.userId === userId) : rows;
}

/** Empties the RB-01 and RB-08 tables and the users (in foreign-key order). */
export async function clearAll(db: Db) {
	for (const table of [
		'notifications',
		'task_labels',
		'task_checklist_items',
		'saved_views',
		'project_columns',
		'labels',
		'tasks',
		'milestones',
		'projects',
		'sessions',
		'invites',
		'user_passwords',
		'auth_attempts',
		'users'
	])
		await db.run(sql.raw(`delete from ${table}`));
}
