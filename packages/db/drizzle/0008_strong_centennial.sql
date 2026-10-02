DROP INDEX "agent_buckets_final_idx";--> statement-breakpoint
DROP INDEX "clients_updated_idx";--> statement-breakpoint
DROP INDEX "intervals_client_time_idx";--> statement-breakpoint
DROP INDEX "agent_buckets_unresolved_idx";--> statement-breakpoint
DROP INDEX "samples_rollup_pending_idx";--> statement-breakpoint
CREATE INDEX "agent_buckets_site_time_idx" ON "agent_buckets" USING btree ("site_id","bucket_start");--> statement-breakpoint
CREATE INDEX "agent_buckets_client_time_idx" ON "agent_buckets" USING btree ("client_id","bucket_start");--> statement-breakpoint
CREATE INDEX "collector_runs_started_idx" ON "collector_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "agent_buckets_unresolved_idx" ON "agent_buckets" USING btree ("site_id","subject","bucket_start") WHERE client_id IS NULL AND subject <> 'unattributed';--> statement-breakpoint
CREATE INDEX "samples_rollup_pending_idx" ON "client_samples" USING btree ("site_id","collected_at") WHERE NOT rollup_applied;--> statement-breakpoint
-- Leave room in each page so frequent updates stay heap-only (no index writes).
ALTER TABLE "traffic_rollups" SET (fillfactor = 80);--> statement-breakpoint
ALTER TABLE "agent_buckets" SET (fillfactor = 80);--> statement-breakpoint
ALTER TABLE "clients" SET (fillfactor = 70);
