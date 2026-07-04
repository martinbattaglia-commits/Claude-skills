CREATE TABLE `broker_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`source` text DEFAULT 'broker' NOT NULL,
	`account_code` text NOT NULL,
	`display_name` text,
	`bucket_id` text,
	`last_synced_at` text,
	`last_inserted` integer DEFAULT 0 NOT NULL,
	`last_skipped` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bucket_id`) REFERENCES `buckets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_broker_connections_acct` ON `broker_connections` (`user_id`,`source`,`account_code`);