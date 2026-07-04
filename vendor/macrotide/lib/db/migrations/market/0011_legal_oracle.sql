CREATE TABLE `fund_dividend_history` (
	`proj_id` text NOT NULL,
	`class_abbr_name` text NOT NULL,
	`book_close_date` text NOT NULL,
	`dividend_date` text,
	`dividend_value` real,
	`last_upd_date` text,
	PRIMARY KEY(`proj_id`, `class_abbr_name`, `book_close_date`),
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fund_dividend_history_proj` ON `fund_dividend_history` (`proj_id`);--> statement-breakpoint
CREATE TABLE `fund_dividend_policy` (
	`proj_id` text NOT NULL,
	`fund_class_name` text NOT NULL,
	`dividend_policy` text,
	`start_date` text,
	`end_date` text,
	`prospectus_type` text,
	`last_upd_date` text,
	PRIMARY KEY(`proj_id`, `fund_class_name`),
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fund_dividend_policy_proj` ON `fund_dividend_policy` (`proj_id`);--> statement-breakpoint
CREATE TABLE `fund_factsheet_urls` (
	`proj_id` text NOT NULL,
	`fund_class_name` text NOT NULL,
	`amc_url_factsheet` text,
	`pdf_factsheet` text,
	`as_of_date` text,
	`prospectus_type` text,
	`last_upd_date` text,
	PRIMARY KEY(`proj_id`, `fund_class_name`),
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fund_factsheet_urls_proj` ON `fund_factsheet_urls` (`proj_id`);--> statement-breakpoint
CREATE TABLE `fund_specifications` (
	`proj_id` text NOT NULL,
	`fund_class_name` text NOT NULL,
	`spec_code` text NOT NULL,
	`spec_desc` text,
	`last_upd_date` text,
	PRIMARY KEY(`proj_id`, `fund_class_name`, `spec_code`),
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fund_specifications_proj` ON `fund_specifications` (`proj_id`);--> statement-breakpoint
CREATE TABLE `fund_subscription_minimums` (
	`proj_id` text NOT NULL,
	`fund_class_name` text NOT NULL,
	`minimum_sub_ipo` real,
	`minimum_sub_ipo_cur` text,
	`minimum_sub` real,
	`minimum_sub_cur` text,
	`minimum_sub_unit` text,
	`minimum_redempt` real,
	`minimum_redempt_cur` text,
	`minimum_redempt_unit` text,
	`lowbal_val` real,
	`lowbal_val_cur` text,
	`lowbal_unit` text,
	`start_date` text,
	`end_date` text,
	`prospectus_type` text,
	`last_upd_date` text,
	PRIMARY KEY(`proj_id`, `fund_class_name`),
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fund_subscription_minimums_proj` ON `fund_subscription_minimums` (`proj_id`);