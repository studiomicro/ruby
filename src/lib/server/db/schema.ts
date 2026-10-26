import { sql } from 'drizzle-orm';
import {
	type AnySQLiteColumn,
	check,
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';
import {
	COMPENSATION_CURRENCIES,
	EMPLOYEE_STATUSES,
	EMPLOYMENT_TYPES,
	EVENT_VISIBILITIES,
	HALF_DAY_PARTS,
	LABEL_COLORS,
	LEAVE_KINDS,
	LEAVE_LEDGER_KINDS,
	LEAVE_STATUSES,
	MILESTONE_STATUSES,
	NOTIFICATION_KINDS,
	NOTIFICATION_TARGET_KINDS,
	PROJECT_STATUSES,
	REC_FREQS,
	REMINDER_MODES,
	REMINDER_OUTCOMES,
	REMINDER_TARGET_KINDS,
	TARGET_KINDS,
	TASK_PRIORITIES,
	TASK_STATUSES,
	TASK_TYPES,
	USER_ROLES,
	USER_STATUSES,
	VIEW_KINDS
} from '../../shared/enums';

/** `col in ('a', 'b')` for a CHECK constraint; the values are compile-time constants, never user input. */
const oneOf = (column: AnySQLiteColumn, values: readonly string[]) =>
	sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

/** Key/value markers (seed version and the like). */
export const appMeta = sqliteTable('app_meta', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	updatedAt: integer('updated_at').notNull()
});

// ── Accounts ────────────────────────────────────────────────────────────────────────────────────────────────

export const users = sqliteTable(
	'users',
	{
		id: text('id').primaryKey(),
		email: text('email').notNull().unique(),
		name: text('name').notNull(),
		role: text('role', { enum: USER_ROLES }).notNull().default('member'),
		status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
		createdAt: integer('created_at').notNull(),
		lastLoginAt: integer('last_login_at'),
		/**
		 * HR capability (RB-05): sees and edits employee records. Granted by an admin, audited; admin is not HR by
		 * itself. Migration 0002 adds it with a column CHECK (0, 1); no table CHECK here, so Drizzle never rebuilds
		 * `users` for it.
		 */
		isHr: integer('is_hr', { mode: 'boolean' }).notNull().default(false)
	},
	(t) => [
		check('users_role_check', oneOf(t.role, USER_ROLES)),
		check('users_status_check', oneOf(t.status, USER_STATUSES))
	]
);

/** PBKDF2-SHA256 credential plus the account lockout counter (auth/password.ts). */
export const userPasswords = sqliteTable('user_passwords', {
	userId: text('user_id')
		.primaryKey()
		.references(() => users.id),
	algo: text('algo').notNull(),
	hash: text('hash').notNull(),
	salt: text('salt').notNull(),
	iterations: integer('iterations').notNull(),
	failedCount: integer('failed_count').notNull().default(0),
	lockedUntil: integer('locked_until'),
	updatedAt: integer('updated_at').notNull()
});

/** Opaque sessions: the cookie holds the token, D1 only its SHA-256. */
export const sessions = sqliteTable(
	'sessions',
	{
		id: text('id').primaryKey(),
		tokenHash: text('token_hash').notNull().unique(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		expiresAt: integer('expires_at').notNull(),
		revokedAt: integer('revoked_at'),
		lastSeenAt: integer('last_seen_at')
	},
	(t) => [index('sessions_user_idx').on(t.userId)]
);

/** Throttle windows (auth/throttle.ts): a SHA-256 of scope and client, never the address itself. */
export const authAttempts = sqliteTable(
	'auth_attempts',
	{
		clientHash: text('client_hash').primaryKey(),
		windowStart: integer('window_start').notNull(),
		count: integer('count').notNull().default(0)
	},
	(t) => [index('auth_attempts_window_idx').on(t.windowStart)]
);

/**
 * Invite links (auth/invites.ts): the link carries the token, D1 only its SHA-256. One use; an accepted, revoked
 * or expired invite admits nobody. The address is where the admin sent it and becomes the account's e-mail.
 */
export const invites = sqliteTable(
	'invites',
	{
		id: text('id').primaryKey(),
		tokenHash: text('token_hash').notNull().unique(),
		email: text('email').notNull(),
		role: text('role', { enum: USER_ROLES }).notNull().default('member'),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		expiresAt: integer('expires_at').notNull(),
		acceptedAt: integer('accepted_at'),
		acceptedBy: text('accepted_by').references(() => users.id),
		revokedAt: integer('revoked_at')
	},
	(t) => [
		check('invites_role_check', oneOf(t.role, USER_ROLES)),
		index('invites_email_idx').on(t.email)
	]
);

// ── Projects and tasks ──────────────────────────────────────────────────────────────────────────────────────

/** Every active user sees every project (one team). `key` prefixes task numbers: `OPS-12`. */
export const projects = sqliteTable(
	'projects',
	{
		id: text('id').primaryKey(),
		key: text('key').notNull().unique(),
		name: text('name').notNull(),
		description: text('description').notNull().default(''),
		status: text('status', { enum: PROJECT_STATUSES }).notNull().default('active'),
		leadId: text('lead_id').references(() => users.id),
		/** The number the next task gets; bumped in the same batch as the task insert. */
		nextTaskNumber: integer('next_task_number').notNull().default(1),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [check('projects_status_check', oneOf(t.status, PROJECT_STATUSES))]
);

export const tasks = sqliteTable(
	'tasks',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		number: integer('number').notNull(),
		title: text('title').notNull(),
		/** Markdown. */
		description: text('description').notNull().default(''),
		status: text('status', { enum: TASK_STATUSES }).notNull().default('todo'),
		priority: text('priority', { enum: TASK_PRIORITIES }).notNull().default('none'),
		assigneeId: text('assignee_id').references(() => users.id),
		/** Calendar date `YYYY-MM-DD`, no time zone. */
		dueOn: text('due_on'),
		/** Order inside a status column; a move takes the midpoint of its neighbours. */
		position: real('position').notNull().default(0),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		completedAt: integer('completed_at'),
		deletedAt: integer('deleted_at'),
		/** RB-08: at most one milestone of the same project; cleared when the milestone is deleted. */
		milestoneId: text('milestone_id').references((): AnySQLiteColumn => milestones.id),
		/**
		 * RB-12: Task, Bug, Feature request or Improvement. Migration 0012 adds it with a column CHECK
		 * (`tasks_type_check`, the TASK_TYPES list); no table CHECK here, so Drizzle never rebuilds `tasks` (and its
		 * FTS triggers) for it. Not indexed for search: a type change never touches `tasks_fts`.
		 */
		type: text('type', { enum: TASK_TYPES }).notNull().default('task')
	},
	(t) => [
		check('tasks_status_check', oneOf(t.status, TASK_STATUSES)),
		check('tasks_priority_check', oneOf(t.priority, TASK_PRIORITIES)),
		uniqueIndex('tasks_project_number_uq').on(t.projectId, t.number),
		index('tasks_project_status_idx').on(t.projectId, t.status, t.position),
		index('tasks_assignee_idx').on(t.assigneeId, t.status),
		index('tasks_milestone_idx')
			.on(t.milestoneId)
			.where(sql`${t.milestoneId} is not null`),
		/** RB-09: the calendar's range read of due dates. */
		index('tasks_due_idx')
			.on(t.dueOn)
			.where(sql`${t.deletedAt} is null and ${t.dueOn} is not null`),
		// RB-12 /issues: live-only indexes for the default sorts, the type filter and the reporter filter.
		index('tasks_live_updated_idx')
			.on(t.updatedAt, t.id)
			.where(sql`${t.deletedAt} is null`),
		index('tasks_live_created_idx')
			.on(t.createdAt, t.id)
			.where(sql`${t.deletedAt} is null`),
		index('tasks_live_type_idx')
			.on(t.type, t.updatedAt)
			.where(sql`${t.deletedAt} is null`),
		index('tasks_created_by_idx')
			.on(t.createdBy, t.createdAt)
			.where(sql`${t.deletedAt} is null`)
	]
);

// ── Project management plus (RB-08) ─────────────────────────────────────────────────────────────────────────

/** A project's labels. `name_key` is the lower-cased name: one live label per name per project, any case. */
export const labels = sqliteTable(
	'labels',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		name: text('name').notNull(),
		nameKey: text('name_key').notNull(),
		color: text('color', { enum: LABEL_COLORS }).notNull(),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		check('labels_color_check', oneOf(t.color, LABEL_COLORS)),
		uniqueIndex('labels_project_name_uq')
			.on(t.projectId, t.nameKey)
			.where(sql`${t.deletedAt} is null`)
	]
);

/**
 * Which labels a task carries. Link rows are not user content: unlinking deletes the row. A soft-deleted label's
 * links stay but every query filters `labels.deleted_at IS NULL`.
 */
export const taskLabels = sqliteTable(
	'task_labels',
	{
		taskId: text('task_id')
			.notNull()
			.references(() => tasks.id),
		labelId: text('label_id')
			.notNull()
			.references(() => labels.id),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.taskId, t.labelId] }),
		index('task_labels_label_idx').on(t.labelId)
	]
);

// ── Team labels (RB-12) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Workspace labels, usable on a task of any project (RB-12 D3: a table of their own, so RB-08's project-scoped
 * `labels` rules stay intact). Admins manage them; any active user applies them. `name_key` is the lower-cased name:
 * one live team label per name, any case. Soft deleted; links stay but every read filters live labels.
 */
export const teamLabels = sqliteTable(
	'team_labels',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		nameKey: text('name_key').notNull(),
		color: text('color', { enum: LABEL_COLORS }).notNull(),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		check('team_labels_color_check', oneOf(t.color, LABEL_COLORS)),
		uniqueIndex('team_labels_name_uq')
			.on(t.nameKey)
			.where(sql`${t.deletedAt} is null`)
	]
);

/** Which team labels a task carries; like `task_labels`, unlinking deletes the row. */
export const taskTeamLabels = sqliteTable(
	'task_team_labels',
	{
		taskId: text('task_id')
			.notNull()
			.references(() => tasks.id),
		teamLabelId: text('team_label_id')
			.notNull()
			.references(() => teamLabels.id),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.taskId, t.teamLabelId] }),
		index('task_team_labels_label_idx').on(t.teamLabelId, t.taskId)
	]
);

/** Steps inside a task. Ticking or editing one never touches `tasks.updated_at`. */
export const taskChecklistItems = sqliteTable(
	'task_checklist_items',
	{
		id: text('id').primaryKey(),
		taskId: text('task_id')
			.notNull()
			.references(() => tasks.id),
		text: text('text').notNull(),
		done: integer('done').notNull().default(0),
		position: real('position').notNull(),
		doneBy: text('done_by').references(() => users.id),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		check('task_checklist_items_done_check', sql`${t.done} in (0, 1)`),
		index('task_checklist_items_task_idx').on(t.taskId, t.deletedAt, t.position)
	]
);

/** A named delivery target of a project; `due_on` is a calendar date like `tasks.due_on`. */
export const milestones = sqliteTable(
	'milestones',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		name: text('name').notNull(),
		description: text('description').notNull().default(''),
		dueOn: text('due_on'),
		status: text('status', { enum: MILESTONE_STATUSES }).notNull().default('open'),
		closedAt: integer('closed_at'),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		check('milestones_status_check', oneOf(t.status, MILESTONE_STATUSES)),
		index('milestones_project_idx').on(t.projectId, t.status, t.dueOn)
	]
);

/**
 * Per-project display settings of the six fixed board columns. A missing row means the defaults (the status's own
 * label, no WIP limit, visible); the stored status never changes.
 */
export const projectColumns = sqliteTable(
	'project_columns',
	{
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id),
		status: text('status', { enum: TASK_STATUSES }).notNull(),
		label: text('label'),
		wipLimit: integer('wip_limit'),
		hidden: integer('hidden').notNull().default(0),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.projectId, t.status] }),
		check('project_columns_status_check', oneOf(t.status, TASK_STATUSES)),
		check(
			'project_columns_wip_check',
			sql`${t.wipLimit} is null or ${t.wipLimit} between 1 and 200`
		),
		check('project_columns_hidden_check', sql`${t.hidden} in (0, 1)`)
	]
);

/**
 * A user's own named filter set: of one project (`list`, `board`), or (RB-12) of the cross-project Issues page
 * (`issues`, no project). `query` is only ever the output of canonicalizeQuery. Migration 0012 rebuilt the table to
 * make `project_id` nullable; the table CHECK ties the kind to the scope.
 */
export const savedViews = sqliteTable(
	'saved_views',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		projectId: text('project_id').references(() => projects.id),
		name: text('name').notNull(),
		kind: text('kind', { enum: VIEW_KINDS }).notNull(),
		query: text('query').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		check('saved_views_kind_check', oneOf(t.kind, VIEW_KINDS)),
		check('saved_views_scope_check', sql`(${t.kind} = 'issues') = (${t.projectId} is null)`),
		// SQLite treats NULLs as distinct in a unique index, so the issues scope needs an index of its own.
		uniqueIndex('saved_views_project_name_uq')
			.on(t.userId, t.projectId, t.name)
			.where(sql`${t.deletedAt} is null and ${t.projectId} is not null`),
		uniqueIndex('saved_views_issues_name_uq')
			.on(t.userId, t.name)
			.where(sql`${t.deletedAt} is null and ${t.projectId} is null`)
	]
);

// ── Knowledge base ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Markdown pages in a tree. `project_id` null: a team-wide page. A child always has its parent's project.
 * `revision` is the number of the latest `page_revisions` row; an edit is accepted only against the revision it
 * was made from (no lost update).
 */
export const pages = sqliteTable(
	'pages',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id').references(() => projects.id),
		parentId: text('parent_id').references((): AnySQLiteColumn => pages.id),
		title: text('title').notNull(),
		body: text('body').notNull().default(''),
		position: real('position').notNull().default(0),
		revision: integer('revision').notNull().default(1),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		updatedBy: text('updated_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		index('pages_project_parent_idx').on(t.projectId, t.parentId, t.position),
		index('pages_parent_idx').on(t.parentId)
	]
);

/** Every saved version of a page, revision 1 included. */
export const pageRevisions = sqliteTable(
	'page_revisions',
	{
		id: text('id').primaryKey(),
		pageId: text('page_id')
			.notNull()
			.references(() => pages.id),
		revision: integer('revision').notNull(),
		title: text('title').notNull(),
		body: text('body').notNull(),
		editedBy: text('edited_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull()
	},
	(t) => [uniqueIndex('page_revisions_page_revision_uq').on(t.pageId, t.revision)]
);

// ── Comments, notifications, attachments ────────────────────────────────────────────────────────────────────

/** A comment on a task or a page. Mentions are written `@[Name](user:<id>)` in the Markdown body. */
export const comments = sqliteTable(
	'comments',
	{
		id: text('id').primaryKey(),
		targetKind: text('target_kind', { enum: TARGET_KINDS }).notNull(),
		targetId: text('target_id').notNull(),
		authorId: text('author_id')
			.notNull()
			.references(() => users.id),
		body: text('body').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		check('comments_target_kind_check', oneOf(t.targetKind, TARGET_KINDS)),
		index('comments_target_idx').on(t.targetKind, t.targetId, t.createdAt)
	]
);

/**
 * In-app notifications. People-triggered kinds (mention, assigned, comment) are never sent to oneself; a `reminder`
 * (RB-09) is from oneself (`actor_id = user_id`) and carries the reminder, the occurrence it was for and a plain-text
 * `summary` snapshotted when it fired. Migration 0011 rebuilt the table for the new columns and CHECKs.
 */
export const notifications = sqliteTable(
	'notifications',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
		actorId: text('actor_id')
			.notNull()
			.references(() => users.id),
		targetKind: text('target_kind', { enum: NOTIFICATION_TARGET_KINDS }).notNull(),
		targetId: text('target_id').notNull(),
		commentId: text('comment_id').references(() => comments.id),
		/** Plain text, at most 140 characters; reminders only. */
		summary: text('summary'),
		reminderId: text('reminder_id').references((): AnySQLiteColumn => reminders.id),
		/** The occurrence (UTC ms) a reminder fired for. */
		occurrenceAt: integer('occurrence_at'),
		createdAt: integer('created_at').notNull(),
		readAt: integer('read_at')
	},
	(t) => [
		check('notifications_kind_check', oneOf(t.kind, NOTIFICATION_KINDS)),
		check('notifications_target_kind_check', oneOf(t.targetKind, NOTIFICATION_TARGET_KINDS)),
		// Only a reminder notification names a reminder. Its `reminder_id` is cleared when the reminder is purged
		// (90 days after it closed); the notification itself stays.
		check('notifications_reminder_check', sql`${t.kind} = 'reminder' or ${t.reminderId} is null`),
		index('notifications_user_idx').on(t.userId, t.readAt, t.createdAt),
		uniqueIndex('notifications_reminder_uq')
			.on(t.reminderId, t.occurrenceAt)
			.where(sql`${t.reminderId} is not null`)
	]
);

/** A file on a task or a page, stored in R2 under `r2_key`; served only through the app after an access check. */
export const attachments = sqliteTable(
	'attachments',
	{
		id: text('id').primaryKey(),
		targetKind: text('target_kind', { enum: TARGET_KINDS }).notNull(),
		targetId: text('target_id').notNull(),
		r2Key: text('r2_key').notNull().unique(),
		filename: text('filename').notNull(),
		contentType: text('content_type').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		uploadedBy: text('uploaded_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		check('attachments_target_kind_check', oneOf(t.targetKind, TARGET_KINDS)),
		index('attachments_target_idx').on(t.targetKind, t.targetId)
	]
);

// ── HR (RB-05; docs/features/rb-05-hrm-roadmap.md sections 4–6) ─────────────────────────────────────────────

/**
 * People, not accounts: an employee may link to one Ruby user (`user_id`, unique among live rows, set by HR).
 * Tier 0 (everyone) and tier 1 (self, direct manager, HR) columns; never indexed for full-text search.
 */
export const employees = sqliteTable(
	'employees',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').references(() => users.id),
		employeeNo: text('employee_no'),
		fullName: text('full_name').notNull(),
		preferredName: text('preferred_name'),
		jobTitle: text('job_title'),
		department: text('department'),
		location: text('location'),
		workEmail: text('work_email'),
		workPhone: text('work_phone'),
		managerId: text('manager_id').references((): AnySQLiteColumn => employees.id),
		employmentType: text('employment_type', { enum: EMPLOYMENT_TYPES }).notNull(),
		status: text('status', { enum: EMPLOYEE_STATUSES }).notNull().default('active'),
		/** Calendar dates `YYYY-MM-DD`. */
		startOn: text('start_on'),
		probationEndsOn: text('probation_ends_on'),
		endOn: text('end_on'),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		check('employees_type_check', oneOf(t.employmentType, EMPLOYMENT_TYPES)),
		check('employees_status_check', oneOf(t.status, EMPLOYEE_STATUSES)),
		uniqueIndex('employees_user_uq')
			.on(t.userId)
			.where(sql`${t.userId} is not null and ${t.deletedAt} is null`),
		uniqueIndex('employees_no_uq')
			.on(t.employeeNo)
			.where(sql`${t.employeeNo} is not null and ${t.deletedAt} is null`),
		index('employees_manager_idx').on(t.managerId),
		index('employees_status_name_idx').on(t.status, t.fullName)
	]
);

/**
 * Tier 2 of one employee (self and HR only). Every `*_enc` column is `v1.<iv>.<ciphertext>` (hr/crypto.ts) with
 * `<employee id>|<field>` as associated data; `*_last4` keeps the last four digits for the masked view.
 */
export const employeePrivate = sqliteTable('employee_private', {
	employeeId: text('employee_id')
		.primaryKey()
		.references(() => employees.id),
	birthDateEnc: text('birth_date_enc'),
	homeAddressEnc: text('home_address_enc'),
	personalPhoneEnc: text('personal_phone_enc'),
	personalEmailEnc: text('personal_email_enc'),
	nikEnc: text('nik_enc'),
	nikLast4: text('nik_last4'),
	npwpEnc: text('npwp_enc'),
	npwpLast4: text('npwp_last4'),
	bpjsKesEnc: text('bpjs_kes_enc'),
	bpjsKesLast4: text('bpjs_kes_last4'),
	bpjsTkEnc: text('bpjs_tk_enc'),
	bpjsTkLast4: text('bpjs_tk_last4'),
	bankName: text('bank_name'),
	bankAccountEnc: text('bank_account_enc'),
	bankAccountLast4: text('bank_account_last4'),
	bankHolderEnc: text('bank_holder_enc'),
	/** The HR_DATA_KEY generation the ciphertexts use (1 until key rotation exists). */
	keyVersion: integer('key_version').notNull().default(1),
	updatedBy: text('updated_by')
		.notNull()
		.references(() => users.id),
	updatedAt: integer('updated_at').notNull()
});

/** Up to three live emergency contacts per employee (tier 2); name and phone encrypted with `<contact id>|<field>`. */
export const employeeEmergencyContacts = sqliteTable(
	'employee_emergency_contacts',
	{
		id: text('id').primaryKey(),
		employeeId: text('employee_id')
			.notNull()
			.references(() => employees.id),
		nameEnc: text('name_enc').notNull(),
		relationship: text('relationship').notNull(),
		phoneEnc: text('phone_enc').notNull(),
		keyVersion: integer('key_version').notNull().default(1),
		position: integer('position').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [index('employee_emergency_contacts_employee_idx').on(t.employeeId, t.position)]
);

/**
 * Salary history (tier 3, HR only; owner answer 2026-10-26). Append-only (migration triggers abort UPDATE and
 * DELETE): a correction is a newer record. `amount_enc` holds the amount in minor units, encrypted with
 * `<record id>|compensation_amount`; never in lists, exports or search.
 */
export const employeeCompensation = sqliteTable(
	'employee_compensation',
	{
		id: text('id').primaryKey(),
		employeeId: text('employee_id')
			.notNull()
			.references(() => employees.id),
		effectiveOn: text('effective_on').notNull(),
		amountEnc: text('amount_enc').notNull(),
		currency: text('currency', { enum: COMPENSATION_CURRENCIES }).notNull().default('IDR'),
		noteEnc: text('note_enc'),
		keyVersion: integer('key_version').notNull().default(1),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		check('employee_compensation_currency_check', oneOf(t.currency, COMPENSATION_CURRENCIES)),
		index('employee_compensation_employee_idx').on(t.employeeId, t.effectiveOn)
	]
);

/**
 * Append-only HR audit trail (migration triggers abort UPDATE and DELETE). Field names only, never values.
 * `user_id` is the account an action is about (link, unlink, HR grant and revoke).
 */
export const hrAuditLog = sqliteTable(
	'hr_audit_log',
	{
		id: text('id').primaryKey(),
		at: integer('at').notNull(),
		actorId: text('actor_id')
			.notNull()
			.references(() => users.id),
		action: text('action').notNull(),
		employeeId: text('employee_id').references(() => employees.id),
		userId: text('user_id').references(() => users.id),
		/** JSON array of at most 20 field names. */
		fields: text('fields').notNull().default('[]'),
		/** At most 200 non-sensitive characters ("42 rows"). */
		detail: text('detail').notNull().default('')
	},
	(t) => [
		index('hr_audit_log_at_idx').on(t.at, t.id),
		index('hr_audit_log_employee_idx').on(t.employeeId, t.at),
		index('hr_audit_log_actor_idx').on(t.actorId, t.at)
	]
);

// ── Time off (RB-06; docs/features/rb-06-time-off/PRD.md) ───────────────────────────────────────────────────

/**
 * Leave types HR maintains (at most 20). `balance` types draw on a yearly entitlement of `annual_half_days`;
 * `logged` types are only recorded. Migration 0003 seeds Annual, Sick, Unpaid and Special. `kind` never changes
 * after creation (the ledger depends on it).
 */
export const leaveTypes = sqliteTable(
	'leave_types',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		kind: text('kind', { enum: LEAVE_KINDS }).notNull(),
		annualHalfDays: integer('annual_half_days').notNull().default(0),
		requiresReason: integer('requires_reason', { mode: 'boolean' }).notNull().default(false),
		active: integer('active', { mode: 'boolean' }).notNull().default(true),
		sort: integer('sort').notNull().default(0),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		check('leave_types_kind_check', oneOf(t.kind, LEAVE_KINDS)),
		check('leave_types_annual_check', sql`${t.annualHalfDays} between 0 and 730`),
		uniqueIndex('leave_types_name_uq').on(sql`lower(${t.name})`)
	]
);

/**
 * Public holidays and cuti bersama, entered by HR (one live row per date). `deducts_leave` 0: a non-working day
 * that a request skips; 1: a working day for leave counting (it deducts like any other day).
 */
export const holidays = sqliteTable(
	'holidays',
	{
		id: text('id').primaryKey(),
		/** Calendar date `YYYY-MM-DD`. */
		onDate: text('on_date').notNull(),
		name: text('name').notNull(),
		deductsLeave: integer('deducts_leave', { mode: 'boolean' }).notNull().default(false),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		check('holidays_deducts_check', sql`${t.deductsLeave} in (0, 1)`),
		uniqueIndex('holidays_date_uq')
			.on(t.onDate)
			.where(sql`${t.deletedAt} is null`)
	]
);

/**
 * One leave request of an employee. `half_days` is computed by the server (work days and holidays), stored at
 * request time and recomputed at approval; `period` is the calendar year of `start_on`. Never deleted: a request
 * ends `approved`, `rejected` or `canceled`.
 */
export const leaveRequests = sqliteTable(
	'leave_requests',
	{
		id: text('id').primaryKey(),
		employeeId: text('employee_id')
			.notNull()
			.references(() => employees.id),
		typeId: text('type_id')
			.notNull()
			.references(() => leaveTypes.id),
		startOn: text('start_on').notNull(),
		endOn: text('end_on').notNull(),
		halfDay: text('half_day', { enum: HALF_DAY_PARTS }).notNull().default('none'),
		halfDays: integer('half_days').notNull(),
		period: integer('period').notNull(),
		reason: text('reason').notNull().default(''),
		status: text('status', { enum: LEAVE_STATUSES }).notNull().default('pending'),
		decidedBy: text('decided_by').references(() => users.id),
		decidedAt: integer('decided_at'),
		decisionNote: text('decision_note').notNull().default(''),
		/**
		 * Approved by the requester themselves, allowed only while no other approver exists (owner answer
		 * 2026-10-26, decision 10 addendum); always audited.
		 */
		selfApproved: integer('self_approved', { mode: 'boolean' }).notNull().default(false),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		check('leave_requests_half_day_check', oneOf(t.halfDay, HALF_DAY_PARTS)),
		check('leave_requests_status_check', oneOf(t.status, LEAVE_STATUSES)),
		check('leave_requests_half_days_check', sql`${t.halfDays} >= 1`),
		check('leave_requests_self_approved_check', sql`${t.selfApproved} in (0, 1)`),
		index('leave_requests_employee_idx').on(t.employeeId, t.status, t.startOn),
		index('leave_requests_status_idx').on(t.status, t.startOn),
		index('leave_requests_range_idx').on(t.startOn, t.endOn)
	]
);

/**
 * The append-only balance ledger (migration triggers abort UPDATE and DELETE): signed half-days per employee, type
 * and year. A balance is the sum of its entries; partial unique indexes allow one grant per employee, type and
 * year and one usage and one reversal per request.
 */
export const leaveLedger = sqliteTable(
	'leave_ledger',
	{
		id: text('id').primaryKey(),
		employeeId: text('employee_id')
			.notNull()
			.references(() => employees.id),
		typeId: text('type_id')
			.notNull()
			.references(() => leaveTypes.id),
		period: integer('period').notNull(),
		halfDays: integer('half_days').notNull(),
		kind: text('kind', { enum: LEAVE_LEDGER_KINDS }).notNull(),
		requestId: text('request_id').references(() => leaveRequests.id),
		note: text('note').notNull().default(''),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		check('leave_ledger_kind_check', oneOf(t.kind, LEAVE_LEDGER_KINDS)),
		uniqueIndex('leave_ledger_grant_uq')
			.on(t.employeeId, t.typeId, t.period)
			.where(sql`${t.kind} = 'grant'`),
		uniqueIndex('leave_ledger_usage_uq')
			.on(t.requestId)
			.where(sql`${t.kind} = 'usage'`),
		uniqueIndex('leave_ledger_reversal_uq')
			.on(t.requestId)
			.where(sql`${t.kind} = 'reversal'`),
		index('leave_ledger_balance_idx').on(t.employeeId, t.typeId, t.period)
	]
);

// ── Calendar and reminders (RB-09; docs/features/rb-09-calendar-reminders/PRD.md) ───────────────────────────────

/**
 * A team event (every active user sees it) or a private one (creator and attendees only). All-day events hold
 * inclusive team dates (`start_on`, `end_on`), timed ones UTC ms (`start_at`, `end_at` exclusive). A series repeats
 * daily, weekly or monthly until `rec_until_on`. `first_on`/`last_on` are the team dates the event or its whole series
 * touches, written by the app with every save, so a window read is one indexed range predicate.
 */
export const events = sqliteTable(
	'events',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id').references(() => projects.id),
		title: text('title').notNull(),
		/** Markdown. */
		description: text('description').notNull().default(''),
		location: text('location').notNull().default(''),
		allDay: integer('all_day', { mode: 'boolean' }).notNull().default(false),
		startOn: text('start_on'),
		endOn: text('end_on'),
		startAt: integer('start_at'),
		endAt: integer('end_at'),
		firstOn: text('first_on').notNull(),
		lastOn: text('last_on').notNull(),
		visibility: text('visibility', { enum: EVENT_VISIBILITIES }).notNull().default('team'),
		recFreq: text('rec_freq', { enum: REC_FREQS }),
		recInterval: integer('rec_interval').notNull().default(1),
		recUntilOn: text('rec_until_on'),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		check('events_all_day_check', sql`${t.allDay} in (0, 1)`),
		check('events_visibility_check', oneOf(t.visibility, EVENT_VISIBILITIES)),
		check('events_rec_freq_check', sql`${t.recFreq} is null or ${oneOf(t.recFreq, REC_FREQS)}`),
		check('events_rec_interval_check', sql`${t.recInterval} between 1 and 30`),
		check('events_rec_until_check', sql`(${t.recFreq} is null) = (${t.recUntilOn} is null)`),
		check(
			'events_shape_check',
			sql`(${t.allDay} = 1 and ${t.startOn} is not null and ${t.endOn} is not null and ${t.startAt} is null and ${t.endAt} is null) or (${t.allDay} = 0 and ${t.startAt} is not null and ${t.endAt} is not null and ${t.startOn} is null and ${t.endOn} is null)`
		),
		index('events_range_idx')
			.on(t.firstOn, t.lastOn)
			.where(sql`${t.deletedAt} is null`),
		index('events_project_idx')
			.on(t.projectId)
			.where(sql`${t.deletedAt} is null`),
		index('events_creator_idx').on(t.createdBy)
	]
);

/** Who attends an event (the creator is implicit and never stored). No RSVP. */
export const eventAttendees = sqliteTable(
	'event_attendees',
	{
		eventId: text('event_id')
			.notNull()
			.references(() => events.id),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.eventId, t.userId] }),
		index('event_attendees_user_idx').on(t.userId)
	]
);

/** One deleted occurrence of a series, by its start date. */
export const eventExceptions = sqliteTable(
	'event_exceptions',
	{
		eventId: text('event_id')
			.notNull()
			.references(() => events.id),
		onDate: text('on_date').notNull(),
		createdBy: text('created_by')
			.notNull()
			.references(() => users.id),
		createdAt: integer('created_at').notNull()
	},
	(t) => [primaryKey({ columns: [t.eventId, t.onDate] })]
);

/**
 * A private nudge of one user on a task, an event or a note of their own. `fire_at` is the next fire time, a cache of
 * the live target that the jobs Worker re-derives before it sends. The claim columns make dispatch idempotent;
 * `done_at`/`outcome` close it. `last_fired_at` is the start of the occurrence last handled (recurring events);
 * `email_sent_at` the fire time last e-mailed.
 */
export const reminders = sqliteTable(
	'reminders',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		targetKind: text('target_kind', { enum: REMINDER_TARGET_KINDS }).notNull(),
		targetId: text('target_id'),
		mode: text('mode', { enum: REMINDER_MODES }).notNull(),
		offsetMin: integer('offset_min'),
		remindAt: integer('remind_at'),
		title: text('title').notNull().default(''),
		fireAt: integer('fire_at').notNull(),
		lastFiredAt: integer('last_fired_at'),
		claimToken: text('claim_token'),
		claimUntil: integer('claim_until'),
		attempts: integer('attempts').notNull().default(0),
		retryAt: integer('retry_at'),
		lastError: text('last_error'),
		doneAt: integer('done_at'),
		outcome: text('outcome', { enum: REMINDER_OUTCOMES }),
		emailSentAt: integer('email_sent_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [
		check('reminders_target_kind_check', oneOf(t.targetKind, REMINDER_TARGET_KINDS)),
		check('reminders_mode_check', oneOf(t.mode, REMINDER_MODES)),
		check('reminders_target_check', sql`(${t.targetKind} = 'personal') = (${t.targetId} is null)`),
		check(
			'reminders_shape_check',
			sql`(${t.mode} = 'relative' and ${t.offsetMin} between 0 and 10080 and ${t.remindAt} is null) or (${t.mode} = 'absolute' and ${t.remindAt} is not null and ${t.offsetMin} is null)`
		),
		check(
			'reminders_outcome_check',
			sql`${t.outcome} is null or ${oneOf(t.outcome, REMINDER_OUTCOMES)}`
		),
		check('reminders_done_check', sql`(${t.doneAt} is null) = (${t.outcome} is null)`),
		index('reminders_due_idx')
			.on(t.fireAt)
			.where(sql`${t.doneAt} is null and ${t.deletedAt} is null`),
		index('reminders_user_idx')
			.on(t.userId, t.doneAt, t.fireAt)
			.where(sql`${t.deletedAt} is null`),
		/** The 24-hour create cap counts every row of a user, deleted ones included. */
		index('reminders_user_created_idx').on(t.userId, t.createdAt),
		index('reminders_target_idx')
			.on(t.targetKind, t.targetId)
			.where(sql`${t.deletedAt} is null`),
		uniqueIndex('reminders_dedupe_uq')
			.on(
				t.userId,
				t.targetKind,
				sql`ifnull(${t.targetId}, '')`,
				t.mode,
				sql`ifnull(${t.offsetMin}, -1)`,
				sql`ifnull(${t.remindAt}, -1)`,
				t.title
			)
			.where(sql`${t.doneAt} is null and ${t.deletedAt} is null`)
	]
);

/**
 * iCal feed tokens (PRD section 5). The feed is off (owner answer O4) and not built; the table exists so switching
 * it on later needs no migration. Only the SHA-256 of a token would be stored.
 */
export const calendarFeedTokens = sqliteTable(
	'calendar_feed_tokens',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id),
		tokenHash: text('token_hash').notNull(),
		createdAt: integer('created_at').notNull(),
		lastUsedAt: integer('last_used_at'),
		revokedAt: integer('revoked_at')
	},
	(t) => [
		uniqueIndex('calendar_feed_tokens_hash_uq').on(t.tokenHash),
		uniqueIndex('calendar_feed_tokens_active_uq')
			.on(t.userId)
			.where(sql`${t.revokedAt} is null`)
	]
);

/** Per-user calendar settings: e-mail reminders (owner answer O5) are opt-in. */
export const userCalendarPrefs = sqliteTable(
	'user_calendar_prefs',
	{
		userId: text('user_id')
			.primaryKey()
			.references(() => users.id),
		emailReminders: integer('email_reminders', { mode: 'boolean' }).notNull().default(false),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [check('user_calendar_prefs_email_check', sql`${t.emailReminders} in (0, 1)`)]
);
