-- Full-text search over pages and tasks (FTS5, external content: the index holds no copy of the text). Kept in
-- step by triggers, so every write path stays indexed. Soft-deleted rows stay in the index; queries join the
-- base table and filter `deleted_at is null`.
CREATE VIRTUAL TABLE `pages_fts` USING fts5(title, body, content='pages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `pages_fts_ai` AFTER INSERT ON `pages` BEGIN
	INSERT INTO pages_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_ad` AFTER DELETE ON `pages` BEGIN
	INSERT INTO pages_fts(pages_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_au` AFTER UPDATE OF title, body ON `pages` BEGIN
	INSERT INTO pages_fts(pages_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
	INSERT INTO pages_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `tasks_fts` USING fts5(title, description, content='tasks', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_ai` AFTER INSERT ON `tasks` BEGIN
	INSERT INTO tasks_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_ad` AFTER DELETE ON `tasks` BEGIN
	INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES ('delete', old.rowid, old.title, old.description);
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_au` AFTER UPDATE OF title, description ON `tasks` BEGIN
	INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES ('delete', old.rowid, old.title, old.description);
	INSERT INTO tasks_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
END;
