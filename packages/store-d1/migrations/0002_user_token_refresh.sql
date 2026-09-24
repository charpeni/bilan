ALTER TABLE `user_tokens` ADD `encrypted_refresh_token` text;--> statement-breakpoint
ALTER TABLE `user_tokens` ADD `expires_at` text;--> statement-breakpoint
ALTER TABLE `user_tokens` ADD `refresh_expires_at` text;