CREATE TABLE "account_limit" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"import_enabled" boolean DEFAULT true NOT NULL,
	"remove_enabled" boolean DEFAULT true NOT NULL,
	"s3_allowed" boolean DEFAULT true NOT NULL,
	"max_stores" integer,
	"max_products_per_run" integer,
	"max_threads" integer,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_limit" ADD CONSTRAINT "account_limit_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_limit" ADD CONSTRAINT "account_limit_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;