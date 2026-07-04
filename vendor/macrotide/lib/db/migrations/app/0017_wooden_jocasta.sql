PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_account_tier` (
	`user_id` text PRIMARY KEY NOT NULL,
	`tier` text DEFAULT 'public' NOT NULL,
	`granted_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_account_tier`("user_id", "tier", "granted_at") SELECT "user_id", "tier", "granted_at" FROM `account_tier`;--> statement-breakpoint
DROP TABLE `account_tier`;--> statement-breakpoint
ALTER TABLE `__new_account_tier` RENAME TO `account_tier`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- Data migration: rename the 'free' access tier to 'public' on existing rows.
UPDATE `account_tier` SET `tier` = 'public' WHERE `tier` = 'free';