CREATE TABLE `session_import_origins` (
	`source_key` text NOT NULL,
	`source_session_id` text NOT NULL,
	`session_id` text NOT NULL,
	`fidelity` text NOT NULL,
	`imported_at` integer NOT NULL,
	PRIMARY KEY(`source_key`, `source_session_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
