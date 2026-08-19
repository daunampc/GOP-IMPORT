CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "csv_map" (
	"signature" text PRIMARY KEY NOT NULL,
	"dialect" text NOT NULL,
	"column_map" jsonb NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_batch" (
	"job_id" text NOT NULL,
	"index" integer NOT NULL,
	"size" integer NOT NULL,
	"succeeded" integer NOT NULL,
	"failed" integer NOT NULL,
	"deduplicated" integer DEFAULT 0 NOT NULL,
	"elapsed_ms" real,
	"wall_ms" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_batch_job_id_index_pk" PRIMARY KEY("job_id","index")
);
--> statement-breakpoint
CREATE TABLE "job_item" (
	"job_id" text PRIMARY KEY NOT NULL,
	"items" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_result" (
	"job_id" text NOT NULL,
	"index" integer NOT NULL,
	"ok" boolean NOT NULL,
	"product_id" integer,
	"sku" text,
	"variation_ids" jsonb,
	"deduplicated" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"error_message" text,
	CONSTRAINT "job_result_job_id_index_pk" PRIMARY KEY("job_id","index")
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'import' NOT NULL,
	"store_id" text,
	"store_url" text NOT NULL,
	"store_label" text NOT NULL,
	"created_by" text,
	"source_label" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"deduplicated" integer DEFAULT 0 NOT NULL,
	"batches" integer DEFAULT 0 NOT NULL,
	"batches_done" integer DEFAULT 0 NOT NULL,
	"plugin_elapsed_ms" real DEFAULT 0 NOT NULL,
	"group_id" text,
	"retry_of" text,
	"options" jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "license_key" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" text,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "license_key_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "preset" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"options" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preview" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"meta" jsonb NOT NULL,
	"products" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"default_threads" integer DEFAULT 10 NOT NULL,
	"default_batch_size" integer DEFAULT 50 NOT NULL,
	"default_mode" text DEFAULT 'standard' NOT NULL,
	"default_image_mode" text DEFAULT 'keep_remote' NOT NULL,
	"history_limit" integer DEFAULT 100 NOT NULL,
	"s3_enabled" boolean DEFAULT false NOT NULL,
	"s3_access_key_id" text DEFAULT '' NOT NULL,
	"s3_secret_encrypted" text DEFAULT '' NOT NULL,
	"s3_bucket" text DEFAULT '' NOT NULL,
	"s3_region" text DEFAULT '' NOT NULL,
	"s3_public_url" text DEFAULT '' NOT NULL,
	"s3_prefix" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_check" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"elapsed_ms" integer NOT NULL,
	"version" text,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"url" text NOT NULL,
	"pin" text DEFAULT '' NOT NULL,
	"api_key" text NOT NULL,
	"api_secret_encrypted" text NOT NULL,
	"url_rewrite" boolean DEFAULT false NOT NULL,
	"base_url_override" text DEFAULT '' NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_check_ok" boolean,
	"last_check_message" text,
	"last_check_ms" integer,
	"plugin_version" text,
	"php_version" text,
	"mysql_version" text,
	"table_prefix" text,
	"site_url" text,
	"missing_functions" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'member' NOT NULL,
	"license_key_id" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_batch" ADD CONSTRAINT "job_batch_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_item" ADD CONSTRAINT "job_item_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_result" ADD CONSTRAINT "job_result_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_key" ADD CONSTRAINT "license_key_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_key" ADD CONSTRAINT "license_key_activated_by_user_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preset" ADD CONSTRAINT "preset_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview" ADD CONSTRAINT "preview_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_check" ADD CONSTRAINT "store_check_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "job_result_ok_idx" ON "job_result" USING btree ("job_id","ok");--> statement-breakpoint
CREATE INDEX "job_status_idx" ON "job" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "job_store_idx" ON "job" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "job_group_idx" ON "job" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "license_activated_idx" ON "license_key" USING btree ("activated_by");--> statement-breakpoint
CREATE UNIQUE INDEX "preset_name_idx" ON "preset" USING btree ("name");--> statement-breakpoint
CREATE INDEX "preview_expiry_idx" ON "preview" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "store_check_store_idx" ON "store_check" USING btree ("store_id","at");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");