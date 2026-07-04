CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bucket_id` text NOT NULL,
	`ticker` text NOT NULL,
	`english_name` text,
	`quote_source` text DEFAULT 'yahoo' NOT NULL,
	`kind` text NOT NULL,
	`trade_date` text NOT NULL,
	`units` real,
	`price_per_unit` real,
	`amount` real NOT NULL,
	`fee` real,
	`trade_currency` text DEFAULT 'THB' NOT NULL,
	`fx_to_thb` real DEFAULT 1 NOT NULL,
	`note` text,
	`source` text,
	`import_batch_id` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`bucket_id`) REFERENCES `buckets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_transactions_bucket` ON `transactions` (`bucket_id`,`trade_date`);