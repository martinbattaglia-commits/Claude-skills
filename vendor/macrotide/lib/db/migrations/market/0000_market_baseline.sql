CREATE TABLE `feeder_look_through_holdings` (
	`proj_id` text NOT NULL,
	`rank` integer NOT NULL,
	`name` text NOT NULL,
	`ticker` text,
	`asset_class` text,
	`isin` text,
	`weight_pct` real,
	`as_of_date` text,
	`fetched_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	PRIMARY KEY(`proj_id`, `rank`),
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_feeder_look_through_proj` ON `feeder_look_through_holdings` (`proj_id`);--> statement-breakpoint
CREATE TABLE `feeder_master_map` (
	`proj_id` text PRIMARY KEY NOT NULL,
	`master_isin` text NOT NULL,
	`master_name` text,
	`provider` text DEFAULT 'ishares' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_feeder_master_map_isin` ON `feeder_master_map` (`master_isin`);--> statement-breakpoint
CREATE TABLE `fund_asset_allocation` (
	`proj_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`prospectus_type` text,
	`asset_seq` integer NOT NULL,
	`asset_name` text,
	`asset_ratio` real,
	`last_upd_date` text,
	PRIMARY KEY(`proj_id`, `asset_seq`),
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fund_asset_alloc_proj` ON `fund_asset_allocation` (`proj_id`);--> statement-breakpoint
CREATE TABLE `fund_catalog` (
	`proj_id` text PRIMARY KEY NOT NULL,
	`abbr_name` text,
	`thai_name` text,
	`english_name` text,
	`amc_name` text,
	`fund_type` text,
	`policy_desc` text,
	`asset_class` text,
	`policy_desc_th` text,
	`management_style` text,
	`tax_incentive_type` text,
	`distribution_policy` text,
	`invest_region` text,
	`is_feeder_fund` integer DEFAULT false NOT NULL,
	`feeder_master_fund` text,
	`is_fixed_term` integer DEFAULT false NOT NULL,
	`init_date` text,
	`isin_code` text,
	`aum` real,
	`aum_date` text,
	`sec_status` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_fund_catalog_asset_class` ON `fund_catalog` (`asset_class`);--> statement-breakpoint
CREATE INDEX `idx_fund_catalog_status` ON `fund_catalog` (`status`);--> statement-breakpoint
CREATE INDEX `idx_fund_catalog_mgmt_style` ON `fund_catalog` (`management_style`);--> statement-breakpoint
CREATE INDEX `idx_fund_catalog_tax` ON `fund_catalog` (`tax_incentive_type`);--> statement-breakpoint
CREATE INDEX `idx_fund_catalog_abbr_name` ON `fund_catalog` (`abbr_name`);--> statement-breakpoint
CREATE INDEX `idx_fund_catalog_english_name` ON `fund_catalog` (`english_name`);--> statement-breakpoint
CREATE INDEX `idx_fund_catalog_thai_name` ON `fund_catalog` (`thai_name`);--> statement-breakpoint
CREATE TABLE `fund_fees` (
	`proj_id` text NOT NULL,
	`fund_class_name` text NOT NULL,
	`fee_type` text NOT NULL,
	`fee_type_raw` text NOT NULL,
	`rate_ceiling_pct` real,
	`actual_rate_pct` real,
	`period_start` text NOT NULL,
	`period_end` text,
	`prospectus_type` text,
	`last_upd_date` text,
	PRIMARY KEY(`proj_id`, `fund_class_name`, `fee_type_raw`, `period_start`),
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fund_fees_current` ON `fund_fees` (`proj_id`,`fee_type`,`period_end`);--> statement-breakpoint
CREATE TABLE `fund_performance` (
	`proj_id` text NOT NULL,
	`fund_class_name` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`prospectus_type` text,
	`performance_type_desc` text NOT NULL,
	`reference_period` text NOT NULL,
	`performance_value` text,
	`last_upd_date` text,
	PRIMARY KEY(`proj_id`, `fund_class_name`, `performance_type_desc`, `reference_period`),
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fund_performance_proj` ON `fund_performance` (`proj_id`);--> statement-breakpoint
CREATE TABLE `fund_portfolio` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proj_id` text NOT NULL,
	`period` text NOT NULL,
	`as_of_date` text,
	`assetliab_id` text,
	`assetliab_desc` text,
	`issue_code` text,
	`isin_code` text,
	`issuer` text,
	`assetliab_value` real,
	`percent_nav` real,
	`last_upd_date` text,
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fund_portfolio_proj` ON `fund_portfolio` (`proj_id`);--> statement-breakpoint
CREATE INDEX `idx_fund_portfolio_proj_period` ON `fund_portfolio` (`proj_id`,`period`);--> statement-breakpoint
CREATE TABLE `fund_portfolio_asset_type` (
	`proj_id` text NOT NULL,
	`period` text NOT NULL,
	`assetliab_code` text NOT NULL,
	`assetliab_desc` text,
	`market_value` real,
	`percent_nav` real,
	PRIMARY KEY(`proj_id`, `period`, `assetliab_code`),
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fund_portfolio_asset_type_proj` ON `fund_portfolio_asset_type` (`proj_id`);--> statement-breakpoint
CREATE INDEX `idx_fund_portfolio_asset_type_proj_period` ON `fund_portfolio_asset_type` (`proj_id`,`period`);--> statement-breakpoint
CREATE TABLE `fund_quotes` (
	`ticker` text PRIMARY KEY NOT NULL,
	`nav` real NOT NULL,
	`d1_pct` real,
	`ytd_pct` real,
	`y1_pct` real,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fund_top_holdings` (
	`proj_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`prospectus_type` text,
	`asset_seq` integer NOT NULL,
	`asset_name` text,
	`asset_ratio` real,
	`last_upd_date` text,
	PRIMARY KEY(`proj_id`, `asset_seq`),
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fund_top_holdings_proj` ON `fund_top_holdings` (`proj_id`);--> statement-breakpoint
CREATE TABLE `nav_history` (
	`ticker` text NOT NULL,
	`date` text NOT NULL,
	`nav` real NOT NULL,
	PRIMARY KEY(`ticker`, `date`)
);
--> statement-breakpoint
CREATE INDEX `idx_nav_history_date` ON `nav_history` (`date`);