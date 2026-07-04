-- Memory overhaul (#221): 2-category taxonomy, content/detail field model,
-- superseded_by edit-history marker, drop dead summary/status columns, and a
-- BM25 FTS5 recall index over content + detail.
--
-- The category/source/status "enums" are drizzle TYPE-level only (plain TEXT in
-- the DB, no CHECK constraint), so the 4→2 remap is a data UPDATE — no rebuild.

-- 1. Remap categories 4 → 2: response_style → advisor (reply form); everything
--    else (profile / finance_context / fact) → user (about the person).
UPDATE `user_preferences` SET `category` = 'advisor' WHERE `category` = 'response_style';
--> statement-breakpoint
UPDATE `user_preferences` SET `category` = 'user' WHERE `category` IN ('profile', 'finance_context', 'fact');
--> statement-breakpoint
-- 2. body → detail (the recall-only elaboration; rename preserves data).
ALTER TABLE `user_preferences` RENAME COLUMN `body` TO `detail`;
--> statement-breakpoint
-- 3. Drop dead columns: `summary` was never populated; `status` was always
--    'active' (the 'pending' lane was never written).
ALTER TABLE `user_preferences` DROP COLUMN `summary`;
--> statement-breakpoint
ALTER TABLE `user_preferences` DROP COLUMN `status`;
--> statement-breakpoint
-- 4. superseded_by: self-FK to the row that replaced this one (set on
--    update/merge, never on a plain forget) so edit-history is distinguishable
--    from a deliberate forget.
ALTER TABLE `user_preferences` ADD COLUMN `superseded_by` INTEGER REFERENCES `user_preferences`(`id`);
--> statement-breakpoint
-- 5. FTS5 recall index over content + detail (external-content, mirrors
--    chat_messages_fts). Indexes ALL rows; the recall query filters
--    valid_until IS NULL. Not expressible in the drizzle schema, so it rides here.
CREATE VIRTUAL TABLE `user_preferences_fts` USING fts5(
  content,
  detail,
  content='user_preferences',
  content_rowid='id',
  tokenize='unicode61'
);
--> statement-breakpoint
INSERT INTO `user_preferences_fts`(`rowid`, `content`, `detail`)
  SELECT `id`, `content`, COALESCE(`detail`, '') FROM `user_preferences`;
--> statement-breakpoint
CREATE TRIGGER `user_preferences_fts_ai` AFTER INSERT ON `user_preferences` BEGIN
  INSERT INTO `user_preferences_fts`(`rowid`, `content`, `detail`)
    VALUES (new.`id`, new.`content`, COALESCE(new.`detail`, ''));
END;
--> statement-breakpoint
CREATE TRIGGER `user_preferences_fts_ad` AFTER DELETE ON `user_preferences` BEGIN
  INSERT INTO `user_preferences_fts`(`user_preferences_fts`, `rowid`, `content`, `detail`)
    VALUES('delete', old.`id`, old.`content`, COALESCE(old.`detail`, ''));
END;
--> statement-breakpoint
CREATE TRIGGER `user_preferences_fts_au` AFTER UPDATE ON `user_preferences` BEGIN
  INSERT INTO `user_preferences_fts`(`user_preferences_fts`, `rowid`, `content`, `detail`)
    VALUES('delete', old.`id`, old.`content`, COALESCE(old.`detail`, ''));
  INSERT INTO `user_preferences_fts`(`rowid`, `content`, `detail`)
    VALUES (new.`id`, new.`content`, COALESCE(new.`detail`, ''));
END;
