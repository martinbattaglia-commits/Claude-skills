CREATE TABLE `memory_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`from_id` integer NOT NULL,
	`to_id` integer NOT NULL,
	`relation` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_id`) REFERENCES `user_preferences`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_id`) REFERENCES `user_preferences`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_memory_links_from` ON `memory_links` (`user_id`,`from_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_links_to` ON `memory_links` (`user_id`,`to_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_preferences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`category` text NOT NULL,
	`content` text NOT NULL,
	`summary` text,
	`body` text,
	`source` text NOT NULL,
	`source_session_id` text,
	`source_turn_ids` text,
	`confidence` real,
	`status` text DEFAULT 'active' NOT NULL,
	`last_confirmed_at` text,
	`valid_from` text NOT NULL,
	`valid_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_session_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_user_preferences`("id", "user_id", "category", "content", "source", "source_session_id", "source_turn_ids", "confidence", "valid_from", "valid_until", "created_at", "updated_at") SELECT "id", "user_id", "category", "content", "source", "source_session_id", "source_turn_ids", "confidence", "valid_from", "valid_until", "created_at", "updated_at" FROM `user_preferences`;--> statement-breakpoint
DROP TABLE `user_preferences`;--> statement-breakpoint
ALTER TABLE `__new_user_preferences` RENAME TO `user_preferences`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_user_pref_active` ON `user_preferences` (`user_id`,`valid_until`);--> statement-breakpoint
CREATE INDEX `idx_user_pref_category` ON `user_preferences` (`user_id`,`category`,`valid_until`);