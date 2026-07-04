ALTER TABLE `fund_catalog` ADD `region_focus` text;--> statement-breakpoint
ALTER TABLE `fund_catalog` ADD `region_focus_source` text;--> statement-breakpoint
ALTER TABLE `fund_catalog` ADD `sector_focus` text;--> statement-breakpoint
ALTER TABLE `fund_catalog` ADD `index_family` text;--> statement-breakpoint
CREATE INDEX `idx_fund_catalog_region_focus` ON `fund_catalog` (`region_focus`);--> statement-breakpoint
CREATE INDEX `idx_fund_catalog_sector_focus` ON `fund_catalog` (`sector_focus`);