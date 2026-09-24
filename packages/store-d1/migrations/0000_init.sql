CREATE TABLE `pull_requests` (
	`repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`updated_at` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`repo_id`, `number`),
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `repo_views` (
	`repo_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`last_viewed_at` text NOT NULL,
	PRIMARY KEY(`repo_id`, `user_id`),
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`is_private` integer DEFAULT false NOT NULL,
	`default_branch` text,
	`total_prs` integer,
	`last_synced_at` text,
	`last_full_sync_at` text,
	`areas_override` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_owner_name` ON `repos` (`owner`,`name`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`requested_by` integer,
	`mode` text NOT NULL,
	`max_prs` integer,
	`status` text NOT NULL,
	`points_spent` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `user_tokens` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`encrypted_token` text NOT NULL,
	`scopes` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`avatar_url` text,
	`created_at` text NOT NULL
);
