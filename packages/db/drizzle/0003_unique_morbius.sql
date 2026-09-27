ALTER TABLE "client_samples" ADD COLUMN "rollup_applied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "traffic_intervals" ADD COLUMN "rollup_applied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "samples_rollup_pending_idx" ON "client_samples" USING btree ("site_id","rollup_applied","collected_at");--> statement-breakpoint
CREATE INDEX "intervals_rollup_pending_idx" ON "traffic_intervals" USING btree ("site_id","rollup_applied","end_at");