import type { ProjectStatus, TaskStatus } from '#lib/shared/enums';
import type { Db } from '#lib/server/db';

/**
 * RB-02's own fixtures: projects and tasks written straight into D1 (RB-02 reads them through its own queries and
 * imports no RB-01 module). Fictional data only.
 */

let counter = 0;

export async function insertProject(
	db: Db,
	createdBy: string,
	options: { key?: string; name?: string; status?: ProjectStatus; deletedAt?: number | null } = {},
	now = Date.now()
): Promise<{ id: string; key: string; name: string }> {
	counter += 1;
	const id = crypto.randomUUID();
	const key =
		options.key ??
		`P${counter}${id
			.slice(0, 3)
			.toUpperCase()
			.replace(/[^A-Z0-9]/g, 'X')}`;
	const name = options.name ?? `Project ${counter}`;
	await db.$client
		.prepare(
			`INSERT INTO projects (id, key, name, status, created_by, created_at, updated_at, deleted_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)`
		)
		.bind(id, key, name, options.status ?? 'active', createdBy, now, options.deletedAt ?? null)
		.run();
	return { id, key, name };
}

export async function insertTask(
	db: Db,
	project: { id: string },
	createdBy: string,
	options: {
		number: number;
		title: string;
		description?: string;
		status?: TaskStatus;
		deletedAt?: number | null;
	},
	now = Date.now()
): Promise<{ id: string }> {
	const id = crypto.randomUUID();
	await db.$client
		.prepare(
			`INSERT INTO tasks (id, project_id, number, title, description, status, created_by, created_at, updated_at, deleted_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)`
		)
		.bind(
			id,
			project.id,
			options.number,
			options.title,
			options.description ?? '',
			options.status ?? 'todo',
			createdBy,
			now,
			options.deletedAt ?? null
		)
		.run();
	return { id };
}

/** Every row of a page's revisions, oldest first. */
export async function revisionsOf(
	db: Db,
	pageId: string
): Promise<{ revision: number; title: string; body: string; editedBy: string }[]> {
	const { results } = await db.$client
		.prepare(
			`SELECT revision, title, body, edited_by AS editedBy FROM page_revisions WHERE page_id = ?1 ORDER BY revision`
		)
		.bind(pageId)
		.all<{ revision: number; title: string; body: string; editedBy: string }>();
	return results;
}

/** A page's raw row (deleted or not). */
export async function pageRow(db: Db, id: string) {
	return db.$client
		.prepare(
			`SELECT id, project_id AS projectId, parent_id AS parentId, title, body, revision, position, deleted_at AS deletedAt
			 FROM pages WHERE id = ?1`
		)
		.bind(id)
		.first<{
			id: string;
			projectId: string | null;
			parentId: string | null;
			title: string;
			body: string;
			revision: number;
			position: number;
			deletedAt: number | null;
		}>();
}
