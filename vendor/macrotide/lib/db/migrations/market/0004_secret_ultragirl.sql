CREATE TABLE `fund_share_classes` (
	`proj_id` text NOT NULL,
	`class_name` text NOT NULL,
	`ticker` text NOT NULL,
	`class_detail_th` text,
	`distribution_policy` text,
	`investor_type` text,
	`tax_incentive_type` text,
	`isin_code` text,
	`current_ter` real,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	PRIMARY KEY(`proj_id`, `class_name`),
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fund_share_classes_ticker` ON `fund_share_classes` (`ticker`);--> statement-breakpoint
CREATE INDEX `idx_fund_share_classes_proj` ON `fund_share_classes` (`proj_id`);--> statement-breakpoint
CREATE INDEX `idx_fund_share_classes_tax` ON `fund_share_classes` (`tax_incentive_type`);--> statement-breakpoint
CREATE INDEX `idx_fund_share_classes_investor` ON `fund_share_classes` (`investor_type`);