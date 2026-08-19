-- Per-account ownership.
--
-- Hand-corrected in two places after `drizzle-kit generate`:
--   1. it emitted the new composite PRIMARY KEY on `csv_map` BEFORE the
--      `owner_id` column that key names, which cannot run;
--   2. it left dropping the OLD `csv_map` primary key as a commented-out TODO,
--      because it cannot look the constraint name up. It is `csv_map_pkey`.
--
-- The business tables were emptied deliberately before this ran (see §4.1 of
-- the brief), which is why every new owner column can be NOT NULL with no
-- default to invent and no ownership to infer.

ALTER TABLE "settings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "settings" CASCADE;--> statement-breakpoint

ALTER TABLE "job" DROP CONSTRAINT "job_created_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "preset" DROP CONSTRAINT "preset_created_by_user_id_fk";--> statement-breakpoint

DROP INDEX "job_status_idx";--> statement-breakpoint
DROP INDEX "preset_name_idx";--> statement-breakpoint

--> the owner columns, then the keys and constraints that name them
ALTER TABLE "store" ADD COLUMN "owner_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "csv_map" ADD COLUMN "owner_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "csv_map" DROP CONSTRAINT "csv_map_pkey";--> statement-breakpoint
ALTER TABLE "csv_map" ADD CONSTRAINT "csv_map_owner_id_signature_pk" PRIMARY KEY("owner_id","signature");--> statement-breakpoint

ALTER TABLE "job" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "preset" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "preview" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint

--> every owner column cascades: an account that leaves takes its data with it
ALTER TABLE "store" ADD CONSTRAINT "store_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_map" ADD CONSTRAINT "csv_map_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preset" ADD CONSTRAINT "preset_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

--> every list query now opens with `where owner = ?`
CREATE INDEX "job_owner_created_idx" ON "job" USING btree ("created_by","created_at");--> statement-breakpoint
CREATE INDEX "job_owner_status_idx" ON "job" USING btree ("created_by","status","created_at");--> statement-breakpoint
CREATE INDEX "job_created_idx" ON "job" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "preset_owner_name_idx" ON "preset" USING btree ("created_by","name");--> statement-breakpoint
CREATE INDEX "preview_owner_idx" ON "preview" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "store_owner_idx" ON "store" USING btree ("owner_id","connected_at");
