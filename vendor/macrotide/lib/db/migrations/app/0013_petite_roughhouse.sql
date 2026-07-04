ALTER TABLE `transactions` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `external_account` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transactions_external_id` ON `transactions` (`external_id`) WHERE "transactions"."external_id" is not null;