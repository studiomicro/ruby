-- RB-12 issues and team labels. Additive for `tasks` (one ADD COLUMN, no rebuild: the tasks_fts triggers from 0001
-- stay as they are, and `type` is not in their `UPDATE OF title, description`, so a type change never re-indexes),
-- two new tables for team labels, and a rebuild of the leaf table `saved_views` (nothing references it; no triggers,
-- no FTS) to make `project_id` nullable for the cross-project Issues views. Every saved_views row is copied,
-- soft-deleted ones too; the old unique index dies with the old table and two partial ones replace it.
CREATE TABLE `task_team_labels` (
	`task_id` text NOT NULL,
	`team_label_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `team_label_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_label_id`) REFERENCES `team_labels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_team_labels_label_idx` ON `task_team_labels` (`team_label_id`,`task_id`);--> statement-breakpoint
CREATE TABLE `team_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`color` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "team_labels_color_check" CHECK("team_labels"."color" in ('gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_labels_name_uq` ON `team_labels` (`name_key`) WHERE "team_labels"."deleted_at" is null;--> statement-breakpoint
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `saved_views_new` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`query` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "saved_views_kind_check" CHECK("kind" in ('list', 'board', 'issues')),
	CONSTRAINT "saved_views_scope_check" CHECK(("kind" = 'issues') = ("project_id" is null))
);
--> statement-breakpoint
INSERT INTO `saved_views_new`("id", "user_id", "project_id", "name", "kind", "query", "created_at", "updated_at", "deleted_at") SELECT "id", "user_id", "project_id", "name", "kind", "query", "created_at", "updated_at", "deleted_at" FROM `saved_views`;--> statement-breakpoint
DROP TABLE `saved_views`;--> statement-breakpoint
ALTER TABLE `saved_views_new` RENAME TO `saved_views`;--> statement-breakpoint
CREATE UNIQUE INDEX `saved_views_project_name_uq` ON `saved_views` (`user_id`,`project_id`,`name`) WHERE "saved_views"."deleted_at" is null and "saved_views"."project_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `saved_views_issues_name_uq` ON `saved_views` (`user_id`,`name`) WHERE "saved_views"."deleted_at" is null and "saved_views"."project_id" is null;--> statement-breakpoint
ALTER TABLE `tasks` ADD `type` text DEFAULT 'task' NOT NULL CONSTRAINT "tasks_type_check" CHECK("type" in ('task', 'bug', 'feature_request', 'improvement'));--> statement-breakpoint
CREATE INDEX `tasks_live_updated_idx` ON `tasks` (`updated_at`,`id`) WHERE "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `tasks_live_created_idx` ON `tasks` (`created_at`,`id`) WHERE "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `tasks_live_type_idx` ON `tasks` (`type`,`updated_at`) WHERE "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `tasks_created_by_idx` ON `tasks` (`created_by`,`created_at`) WHERE "tasks"."deleted_at" is null;