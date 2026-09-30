DROP INDEX "agent_buckets_key";--> statement-breakpoint
ALTER TABLE "agent_buckets" ADD COLUMN "run_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_buckets_key" ON "agent_buckets" USING btree ("site_id","subject","bucket_start","scope","direction","run_id");