CREATE TABLE `action_item_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`item_type` text NOT NULL,
	`item_key` text NOT NULL,
	`state` text NOT NULL,
	`snooze_until` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_action_item_user_key` ON `action_item_states` (`user_id`,`item_key`);