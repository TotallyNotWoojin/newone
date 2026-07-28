CREATE TABLE `action_events` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`previous_status` text NOT NULL,
	`new_status` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`action_id`) REFERENCES `action_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_email`) REFERENCES `profiles`(`email`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `action_items` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`title_ko` text NOT NULL,
	`title_es` text NOT NULL,
	`owner` text,
	`due_label` text,
	`status` text DEFAULT 'needs_confirmation' NOT NULL,
	`source_message_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "action_items_status_check" CHECK("action_items"."status" IN ('needs_confirmation', 'open', 'done'))
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`client_message_id` text NOT NULL,
	`sender_email` text NOT NULL,
	`sender_name` text NOT NULL,
	`source_text` text NOT NULL,
	`source_language` text NOT NULL,
	`target_language` text NOT NULL,
	`translated_text` text,
	`detected_language` text,
	`translation_warning` text,
	`translation_status` text DEFAULT 'pending' NOT NULL,
	`translation_started_at` text,
	`message_kind` text DEFAULT 'message' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`delivery_status` text DEFAULT 'delivered' NOT NULL,
	`human_reviewed` integer DEFAULT false NOT NULL,
	`provider` text,
	`model` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`translated_at` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_email`) REFERENCES `profiles`(`email`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "messages_source_language_check" CHECK("messages"."source_language" IN ('ko', 'es')),
	CONSTRAINT "messages_target_language_check" CHECK("messages"."target_language" IN ('ko', 'es')),
	CONSTRAINT "messages_translation_status_check" CHECK("messages"."translation_status" IN ('pending', 'translating', 'translated', 'retryable_failed', 'permanent_failed')),
	CONSTRAINT "messages_kind_check" CHECK("messages"."message_kind" IN ('message', 'safety', 'production', 'maintenance', 'quality', 'handoff', 'instruction')),
	CONSTRAINT "messages_priority_check" CHECK("messages"."priority" IN ('normal', 'important', 'safety'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_sender_client_idx` ON `messages` (`sender_email`,`client_message_id`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`email` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`preferred_language` text DEFAULT 'es' NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "profiles_language_check" CHECK("profiles"."preferred_language" IN ('ko', 'es')),
	CONSTRAINT "profiles_role_check" CHECK("profiles"."role" IN ('member', 'manager', 'admin'))
);
--> statement-breakpoint
CREATE TABLE `summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`headline_ko` text NOT NULL,
	`headline_es` text NOT NULL,
	`summary_ko` text NOT NULL,
	`summary_es` text NOT NULL,
	`source_message_ids` text DEFAULT '[]' NOT NULL,
	`generated_by` text DEFAULT 'demo' NOT NULL,
	`model` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `summary_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`source_fingerprint` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`summary_id` text,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "summary_runs_status_check" CHECK("summary_runs"."status" IN ('running', 'complete', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `summary_runs_thread_fingerprint_idx` ON `summary_runs` (`thread_id`,`source_fingerprint`);--> statement-breakpoint
CREATE TABLE `thread_members` (
	`thread_id` text NOT NULL,
	`user_email` text NOT NULL,
	`joined_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_email`) REFERENCES `profiles`(`email`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_members_thread_user_idx` ON `thread_members` (`thread_id`,`user_email`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`subtitle` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'operations' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`shift_key` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
