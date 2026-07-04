CREATE TABLE `fund_benchmarks` (
	`proj_id` text NOT NULL,
	`group_seq` integer NOT NULL,
	`benchmark` text NOT NULL,
	`benchmark_remark` text,
	`start_date` text,
	`end_date` text,
	`prospectus_type` text,
	`last_upd_date` text,
	PRIMARY KEY(`proj_id`, `group_seq`),
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fund_benchmarks_proj` ON `fund_benchmarks` (`proj_id`);--> statement-breakpoint
CREATE TABLE `fund_statistics` (
	`proj_id` text NOT NULL,
	`fund_class_name` text NOT NULL,
	`portfolio_turnover_ratio` real,
	`maximum_drawdown` real,
	`sharpe_ratio` real,
	`beta` real,
	`alpha` real,
	`fx_hedging_ratio` real,
	`tracking_error` real,
	`yield_to_maturity` text,
	`recovering_period` text,
	`portfolio_duration_period` text,
	`start_date` text,
	`end_date` text,
	`prospectus_type` text,
	`last_upd_date` text,
	PRIMARY KEY(`proj_id`, `fund_class_name`),
	FOREIGN KEY (`proj_id`) REFERENCES `fund_catalog`(`proj_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fund_statistics_proj` ON `fund_statistics` (`proj_id`);