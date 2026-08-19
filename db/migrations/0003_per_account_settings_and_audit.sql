CREATE TABLE "secret_reveal" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"actor_email" text NOT NULL,
	"target_user_id" text,
	"target_email" text NOT NULL,
	"kind" text NOT NULL,
	"subject_id" text,
	"subject_label" text NOT NULL,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"owner_id" text PRIMARY KEY NOT NULL,
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
ALTER TABLE "secret_reveal" ADD CONSTRAINT "secret_reveal_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_reveal" ADD CONSTRAINT "secret_reveal_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secret_reveal_at_idx" ON "secret_reveal" USING btree ("at");--> statement-breakpoint
CREATE INDEX "secret_reveal_actor_idx" ON "secret_reveal" USING btree ("actor_id","at");--> statement-breakpoint
CREATE INDEX "secret_reveal_target_idx" ON "secret_reveal" USING btree ("target_user_id","at");