CREATE TABLE `security_id_map` (
	`id_value` text PRIMARY KEY NOT NULL,
	`ticker` text,
	`resolved_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `us_dividends` (
	`symbol` text NOT NULL,
	`ex_date` text NOT NULL,
	`payable_date` text,
	`record_date` text,
	`cash_amount` real,
	`special` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`symbol`, `ex_date`)
);
--> statement-breakpoint
CREATE INDEX `idx_us_dividends_symbol` ON `us_dividends` (`symbol`);--> statement-breakpoint
CREATE TABLE `us_etf_holdings` (
	`symbol` text NOT NULL,
	`rank` integer NOT NULL,
	`name` text NOT NULL,
	`cusip` text,
	`isin` text,
	`weight_pct` real,
	`country` text,
	`asset_cat` text,
	`counterparty` text,
	`resolved_symbol` text,
	PRIMARY KEY(`symbol`, `rank`)
);
--> statement-breakpoint
CREATE INDEX `idx_us_etf_holdings_symbol` ON `us_etf_holdings` (`symbol`);--> statement-breakpoint
CREATE INDEX `idx_us_etf_holdings_resolved` ON `us_etf_holdings` (`resolved_symbol`);--> statement-breakpoint
CREATE TABLE `us_securities` (
	`symbol` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`security_type` text NOT NULL,
	`exchange` text,
	`asset_class` text,
	`figi` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`view_count` integer DEFAULT 0 NOT NULL,
	`last_viewed_at` text,
	`popularity_score` real DEFAULT 0 NOT NULL,
	`last_scored_at` text,
	`cik` text,
	`sic` text,
	`industry` text,
	`gics_sector` text,
	`gics_sub_industry` text,
	`indices` text,
	`tracks_index` text,
	`shares_outstanding` integer,
	`market_cap` real,
	`eps_diluted` real,
	`pe_ratio` real,
	`pb_ratio` real,
	`net_margin` real,
	`ter` real,
	`fundamentals_as_of` text,
	`last_enriched_at` text,
	`holdings_as_of` text,
	`holdings_fetched_at` text,
	`holdings_count` integer,
	`dividends_fetched_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_us_securities_type` ON `us_securities` (`security_type`);--> statement-breakpoint
CREATE INDEX `idx_us_securities_status` ON `us_securities` (`status`);--> statement-breakpoint
CREATE INDEX `idx_us_securities_name` ON `us_securities` (`name`);--> statement-breakpoint
CREATE INDEX `idx_us_securities_popularity` ON `us_securities` (`popularity_score`);--> statement-breakpoint
CREATE INDEX `idx_us_securities_last_viewed` ON `us_securities` (`last_viewed_at`);--> statement-breakpoint
CREATE INDEX `idx_us_securities_figi` ON `us_securities` (`figi`);--> statement-breakpoint
CREATE INDEX `idx_us_securities_enriched` ON `us_securities` (`last_enriched_at`);--> statement-breakpoint
CREATE INDEX `idx_us_securities_holdings_fetched` ON `us_securities` (`holdings_fetched_at`);--> statement-breakpoint
CREATE INDEX `idx_us_securities_tracks_index` ON `us_securities` (`tracks_index`);