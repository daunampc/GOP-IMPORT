ALTER TABLE "job" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "cancel_mode" text;