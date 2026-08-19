ALTER TABLE "settings" ADD COLUMN "notify_webhook_url" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "notify_webhook_secret_encrypted" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "notify_failures_only" boolean DEFAULT false NOT NULL;