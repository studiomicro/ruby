import { sql } from 'drizzle-orm';
import type { SessionUser } from '#lib/server/auth/session';
import type { Db } from '#lib/server/db';
import { createPage } from '#lib/server/kb/repo';
import type { Project } from '#lib/server/projects/repo';
import { seedProject, seedTask } from './seed-tasks';
import { insertUser } from './users';

/**
 * RB-03 fixtures: fictional people, a project with one task (created by `creator`, assigned to `assignee`) and a
 * team page (created by `creator`), written through the real RB-01 and RB-02 repo functions.
 */
export interface Discussion {
	admin: SessionUser;
	author: SessionUser;
	assignee: SessionUser;
	creator: SessionUser;
	bystander: SessionUser;
	disabled: SessionUser;
	project: Project;
	task: { id: string; number: number };
	pageId: string;
}

export async function seedDiscussion(db: Db, at = Date.now()): Promise<Discussion> {
	const admin = await insertUser(db, { role: 'admin', name: 'Ada Admin' });
	const author = await insertUser(db, { name: 'Ari Author' });
	const assignee = await insertUser(db, { name: 'Asa Assignee' });
	const creator = await insertUser(db, { name: 'Cleo Creator' });
	const bystander = await insertUser(db, { name: 'Bo Bystander' });
	const disabled = await insertUser(db, { name: 'Dee Disabled', status: 'disabled' });
	const project = await seedProject(db, creator, { name: 'Discussion project' }, at);
	const task = await seedTask(
		db,
		creator,
		project,
		{ title: 'Fix the fictional login', assigneeId: assignee.id },
		at
	);
	const page = await createPage(
		db,
		creator,
		{ title: 'Fictional runbook', body: 'Steps.', projectId: null, parentId: null },
		at
	);
	if (!page.ok) throw new Error(page.error);
	return { admin, author, assignee, creator, bystander, disabled, project, task, pageId: page.id };
}

/** Empties every table RB-03 tests write (in foreign-key order). */
export async function clearDiscussion(db: Db) {
	for (const table of [
		'notifications',
		'comments',
		'page_revisions',
		'pages',
		'tasks',
		'projects',
		'auth_attempts',
		'sessions',
		'invites',
		'user_passwords',
		'users'
	])
		await db.run(sql.raw(`delete from ${table}`));
}

/** The comment notifications (`mention`, `comment`) of `userId`, oldest first; RB-01's `assigned` rows are left out. */
export async function notificationsOf(db: Db, userId: string) {
	const { results } = await db.$client
		.prepare(
			`SELECT kind, actor_id AS actorId, target_kind AS targetKind, target_id AS targetId, comment_id AS commentId,
				read_at AS readAt FROM notifications WHERE user_id = ?1 AND kind <> 'assigned' ORDER BY created_at, id`
		)
		.bind(userId)
		.all<{
			kind: string;
			actorId: string;
			targetKind: string;
			targetId: string;
			commentId: string | null;
			readAt: number | null;
		}>();
	return results;
}

/** Every comment row on a target, deleted or not. */
export async function commentRows(db: Db, targetId: string) {
	const { results } = await db.$client
		.prepare(
			`SELECT id, author_id AS authorId, body, created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt
			 FROM comments WHERE target_id = ?1 ORDER BY created_at, id`
		)
		.bind(targetId)
		.all<{
			id: string;
			authorId: string;
			body: string;
			createdAt: number;
			updatedAt: number;
			deletedAt: number | null;
		}>();
	return results;
}
