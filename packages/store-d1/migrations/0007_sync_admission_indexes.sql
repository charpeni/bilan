CREATE INDEX `sync_jobs_repo_created` ON `sync_jobs` (`repo_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sync_jobs_user_created` ON `sync_jobs` (`requested_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `sync_jobs_status_user` ON `sync_jobs` (`status`,`requested_by`);--> statement-breakpoint
CREATE INDEX `sync_jobs_created` ON `sync_jobs` (`created_at`);