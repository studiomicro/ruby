-- RB-08 project management plus: labels, checklists, milestones, board column settings, saved views, and
-- tasks.milestone_id. Additive only: no table rebuild, so the tasks_fts triggers from 0001 are untouched (the new
-- column and tables are not indexed for search). Existing tasks get milestone_id NULL.
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`color` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "labels_color_check" CHECK("labels"."color" in ('gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_project_name_uq` ON `labels` (`project_id`,`name_key`) WHERE "labels"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`due_on` text,
	`status` text DEFAULT 'open' NOT NULL,
	`closed_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "milestones_status_check" CHECK("milestones"."status" in ('open', 'closed'))
);
--> statement-breakpoint
CREATE INDEX `milestones_project_idx` ON `milestones` (`project_id`,`status`,`due_on`);--> statement-breakpoint
CREATE TABLE `project_columns` (
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`label` text,
	`wip_limit` integer,
	`hidden` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `status`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_columns_status_check" CHECK("project_columns"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled')),
	CONSTRAINT "project_columns_wip_check" CHECK("project_columns"."wip_limit" is null or "project_columns"."wip_limit" between 1 and 200),
	CONSTRAINT "project_columns_hidden_check" CHECK("project_columns"."hidden" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`query` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "saved_views_kind_check" CHECK("saved_views"."kind" in ('list', 'board'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_views_user_project_name_uq` ON `saved_views` (`user_id`,`project_id`,`name`) WHERE "saved_views"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `task_checklist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`text` text NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`position` real NOT NULL,
	`done_by` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`done_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_checklist_items_done_check" CHECK("task_checklist_items"."done" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `task_checklist_items_task_idx` ON `task_checklist_items` (`task_id`,`deleted_at`,`position`);--> statement-breakpoint
CREATE TABLE `task_labels` (
	`task_id` text NOT NULL,
	`label_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `label_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_labels_label_idx` ON `task_labels` (`label_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `milestone_id` text REFERENCES milestones(id);--> statement-breakpoint
CREATE INDEX `tasks_milestone_idx` ON `tasks` (`milestone_id`) WHERE "tasks"."milestone_id" is not null;
