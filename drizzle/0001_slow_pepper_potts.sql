CREATE INDEX `action_events_action_created_idx` ON `action_events` (`action_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `action_items_thread_status_idx` ON `action_items` (`thread_id`,`status`);--> statement-breakpoint
CREATE INDEX `messages_thread_created_idx` ON `messages` (`thread_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `summaries_thread_created_idx` ON `summaries` (`thread_id`,`created_at`);