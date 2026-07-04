CREATE TABLE `sec_raw` (
	`endpoint` text NOT NULL,
	`proj_id` text NOT NULL,
	`row_key` text NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	PRIMARY KEY(`endpoint`, `proj_id`, `row_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_sec_raw_endpoint` ON `sec_raw` (`endpoint`);