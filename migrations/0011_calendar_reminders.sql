-- RB-09 calendar and reminders (docs/features/rb-09-calendar-reminders/PRD.md › Migration). Hand-written; the Drizzle
-- snapshot (meta/0011_snapshot.json) was generated from schema.ts and matches this DDL. Additive except the
-- `notifications` rebuild in part 2, which copies every row and recreates every index.

-- 1. New tables. `reminders` before the notifications rebuild: the rebuilt table references it.
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`all_day` integer DEFAULT 0 NOT NULL,
	`start_on` text,
	`end_on` text,
	`start_at` integer,
	`end_at` integer,
	`first_on` text NOT NULL,
	`last_on` text NOT NULL,
	`visibility` text DEFAULT 'team' NOT NULL,
	`rec_freq` text,
	`rec_interval` integer DEFAULT 1 NOT NULL,
	`rec_until_on` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_all_day_check" CHECK("all_day" in (0, 1)),
	CONSTRAINT "events_visibility_check" CHECK("visibility" in ('team', 'private')),
	CONSTRAINT "events_rec_freq_check" CHECK("rec_freq" is null or "rec_freq" in ('daily', 'weekly', 'monthly')),
	CONSTRAINT "events_rec_interval_check" CHECK("rec_interval" between 1 and 30),
	CONSTRAINT "events_rec_until_check" CHECK(("rec_freq" is null) = ("rec_until_on" is null)),
	CONSTRAINT "events_shape_check" CHECK(("all_day" = 1 and "start_on" is not null and "end_on" is not null and "start_at" is null and "end_at" is null) or ("all_day" = 0 and "start_at" is not null and "end_at" is not null and "start_on" is null and "end_on" is null))
);
--> statement-breakpoint
CREATE INDEX `events_range_idx` ON `events` (`first_on`,`last_on`) WHERE "deleted_at" is null;
--> statement-breakpoint
CREATE INDEX `events_project_idx` ON `events` (`project_id`) WHERE "deleted_at" is null;
--> statement-breakpoint
CREATE INDEX `events_creator_idx` ON `events` (`created_by`);
--> statement-breakpoint
CREATE TABLE `event_attendees` (
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`event_id`, `user_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `event_attendees_user_idx` ON `event_attendees` (`user_id`);
--> statement-breakpoint
CREATE TABLE `event_exceptions` (
	`event_id` text NOT NULL,
	`on_date` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`event_id`, `on_date`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text,
	`mode` text NOT NULL,
	`offset_min` integer,
	`remind_at` integer,
	`title` text DEFAULT '' NOT NULL,
	`fire_at` integer NOT NULL,
	`last_fired_at` integer,
	`claim_token` text,
	`claim_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`last_error` text,
	`done_at` integer,
	`outcome` text,
	`email_sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reminders_target_kind_check" CHECK("target_kind" in ('task', 'event', 'personal')),
	CONSTRAINT "reminders_mode_check" CHECK("mode" in ('relative', 'absolute')),
	CONSTRAINT "reminders_target_check" CHECK(("target_kind" = 'personal') = ("target_id" is null)),
	CONSTRAINT "reminders_shape_check" CHECK(("mode" = 'relative' and "offset_min" between 0 and 10080 and "remind_at" is null) or ("mode" = 'absolute' and "remind_at" is not null and "offset_min" is null)),
	CONSTRAINT "reminders_outcome_check" CHECK("outcome" is null or "outcome" in ('sent', 'missed', 'canceled', 'dead')),
	CONSTRAINT "reminders_done_check" CHECK(("done_at" is null) = ("outcome" is null))
);
--> statement-breakpoint
CREATE INDEX `reminders_due_idx` ON `reminders` (`fire_at`) WHERE "done_at" is null and "deleted_at" is null;
--> statement-breakpoint
CREATE INDEX `reminders_user_idx` ON `reminders` (`user_id`,`done_at`,`fire_at`) WHERE "deleted_at" is null;
--> statement-breakpoint
CREATE INDEX `reminders_user_created_idx` ON `reminders` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `reminders_target_idx` ON `reminders` (`target_kind`,`target_id`) WHERE "deleted_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX `reminders_dedupe_uq` ON `reminders` (`user_id`, `target_kind`, ifnull(`target_id`, ''), `mode`, ifnull(`offset_min`, -1), ifnull(`remind_at`, -1), `title`) WHERE "done_at" is null and "deleted_at" is null;
--> statement-breakpoint
CREATE TABLE `calendar_feed_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_feed_tokens_hash_uq` ON `calendar_feed_tokens` (`token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_feed_tokens_active_uq` ON `calendar_feed_tokens` (`user_id`) WHERE "revoked_at" is null;
--> statement-breakpoint
CREATE TABLE `user_calendar_prefs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email_reminders` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_calendar_prefs_email_check" CHECK("email_reminders" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `tasks_due_idx` ON `tasks` (`due_on`) WHERE "deleted_at" is null and "due_on" is not null;
--> statement-breakpoint
-- 2. Rebuild `notifications` (SQLite cannot change a CHECK in place). Nothing references notifications, so no other
--    table is affected. D1 enforces foreign keys and ignores `PRAGMA foreign_keys = off`; this defers the checks to
--    the end of the migration's transaction instead. Old columns keep their order; every row is copied as it is;
--    the one index the old table had (`notifications_user_idx`) is recreated, plus the new reminder key.
PRAGMA defer_foreign_keys = on;
--> statement-breakpoint
DROP TABLE IF EXISTS `notifications_new`;
--> statement-breakpoint
CREATE TABLE `notifications_new` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`comment_id` text,
	`summary` text,
	`reminder_id` text,
	`occurrence_at` integer,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reminder_id`) REFERENCES `reminders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notifications_kind_check" CHECK("kind" in ('mention', 'assigned', 'comment', 'reminder')),
	CONSTRAINT "notifications_target_kind_check" CHECK("target_kind" in ('task', 'page', 'event', 'personal')),
	CONSTRAINT "notifications_reminder_check" CHECK("kind" = 'reminder' or "reminder_id" is null)
);
--> statement-breakpoint
INSERT INTO `notifications_new` (`id`, `user_id`, `kind`, `actor_id`, `target_kind`, `target_id`, `comment_id`, `created_at`, `read_at`)
	SELECT `id`, `user_id`, `kind`, `actor_id`, `target_kind`, `target_id`, `comment_id`, `created_at`, `read_at` FROM `notifications`;
--> statement-breakpoint
DROP TABLE `notifications`;
--> statement-breakpoint
ALTER TABLE `notifications_new` RENAME TO `notifications`;
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`read_at`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_reminder_uq` ON `notifications` (`reminder_id`,`occurrence_at`) WHERE "reminder_id" is not null;
