-- Full-text search over chat messages.
--
-- External-content FTS5 table mirroring `chat_messages.content`. We store no
-- duplicate text (content='chat_messages'); the index keys back to the source
-- row via content_rowid='id'. Three sync triggers keep the index in lock-step
-- with INSERT / UPDATE / DELETE on chat_messages (the canonical FTS5 external-
-- content pattern). Thread titles are short, so title search is handled with a
-- plain LIKE in the query layer rather than a second virtual table.
--
-- FTS5 is not expressible in the drizzle schema, so this rides as a custom
-- migration on top of the generated app baseline.
CREATE VIRTUAL TABLE `chat_messages_fts` USING fts5(
  content,
  content='chat_messages',
  content_rowid='id',
  tokenize='unicode61'
);
--> statement-breakpoint
-- Backfill any rows that already exist (no-op on a fresh database).
INSERT INTO `chat_messages_fts`(`rowid`, `content`)
  SELECT `id`, `content` FROM `chat_messages`;
--> statement-breakpoint
CREATE TRIGGER `chat_messages_fts_ai` AFTER INSERT ON `chat_messages` BEGIN
  INSERT INTO `chat_messages_fts`(`rowid`, `content`) VALUES (new.`id`, new.`content`);
END;
--> statement-breakpoint
CREATE TRIGGER `chat_messages_fts_ad` AFTER DELETE ON `chat_messages` BEGIN
  INSERT INTO `chat_messages_fts`(`chat_messages_fts`, `rowid`, `content`) VALUES('delete', old.`id`, old.`content`);
END;
--> statement-breakpoint
CREATE TRIGGER `chat_messages_fts_au` AFTER UPDATE ON `chat_messages` BEGIN
  INSERT INTO `chat_messages_fts`(`chat_messages_fts`, `rowid`, `content`) VALUES('delete', old.`id`, old.`content`);
  INSERT INTO `chat_messages_fts`(`rowid`, `content`) VALUES (new.`id`, new.`content`);
END;