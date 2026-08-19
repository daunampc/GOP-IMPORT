CREATE TABLE "job_schedule" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by" text NOT NULL,
	"store_id" text NOT NULL,
	"store_url" text NOT NULL,
	"store_label" text NOT NULL,
	"kind" text DEFAULT 'import' NOT NULL,
	"source_label" text NOT NULL,
	"options" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"every_minutes" integer NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"next_job_id" text,
	"last_fired_at" timestamp with time zone,
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "schedule_id" text;--> statement-breakpoint
ALTER TABLE "job_schedule" ADD CONSTRAINT "job_schedule_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_schedule" ADD CONSTRAINT "job_schedule_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_schedule_owner_idx" ON "job_schedule" USING btree ("created_by","created_at");