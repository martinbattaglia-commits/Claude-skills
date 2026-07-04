CREATE TABLE `earmarks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`scope` text DEFAULT 'account' NOT NULL,
	`role` text DEFAULT 'reserved' NOT NULL,
	`bucket_id` text NOT NULL,
	`ticker` text,
	`amount` real,
	`currency` text,
	`purpose` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bucket_id`) REFERENCES `buckets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_earmarks_target` ON `earmarks` (`bucket_id`,`ticker`,`scope`);--> statement-breakpoint
CREATE INDEX `idx_earmarks_bucket` ON `earmarks` (`bucket_id`);--> statement-breakpoint
ALTER TABLE `holdings` ADD `currency` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `reconcile` integer;