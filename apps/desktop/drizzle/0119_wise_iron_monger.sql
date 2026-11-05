CREATE TABLE `orca_context_events` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_session_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`worker_session_id` text NOT NULL,
	`policy` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_orca_context_events_lead_created` ON `orca_context_events` (`lead_session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_orca_context_events_worker_created` ON `orca_context_events` (`worker_id`,`created_at`);