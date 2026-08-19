CREATE TABLE "job_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"stage" text NOT NULL,
	"batch_index" integer,
	"message" text NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
ALTER TABLE "job_log" ADD CONSTRAINT "job_log_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_log_job_idx" ON "job_log" USING btree ("job_id","id");