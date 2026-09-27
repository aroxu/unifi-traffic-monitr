CREATE TABLE "client_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source" text NOT NULL,
	"scope" text NOT NULL,
	"direction" text NOT NULL,
	"session_key" text,
	"counter_bytes" bigint NOT NULL,
	"observed_at" timestamp with time zone,
	"collected_at" timestamp with time zone NOT NULL,
	"quality" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"mac" text NOT NULL,
	"unifi_id" text,
	"name" text,
	"ip" text,
	"connection" text,
	"device_id" uuid,
	"online" boolean,
	"last_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collector_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"source" text NOT NULL,
	"scope" text NOT NULL,
	"direction" text NOT NULL,
	"session_key" text,
	"value" bigint NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collector_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"error_code" text,
	"client_count" integer
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"unifi_id" text NOT NULL,
	"name" text,
	"model" text,
	"type" text,
	"online" boolean,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"timezone" text DEFAULT 'Asia/Seoul' NOT NULL,
	"raw_retention_days" integer DEFAULT 7 NOT NULL,
	"five_minute_retention_days" integer DEFAULT 90 NOT NULL,
	"hourly_retention_days" integer DEFAULT 365 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unifi_id" text NOT NULL,
	"internal_name" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sites_unifi_id_unique" UNIQUE("unifi_id")
);
--> statement-breakpoint
CREATE TABLE "traffic_intervals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"sample_id" uuid NOT NULL,
	"source" text NOT NULL,
	"scope" text NOT NULL,
	"direction" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"bytes" bigint NOT NULL,
	"estimated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "traffic_intervals_sample_id_unique" UNIQUE("sample_id")
);
--> statement-breakpoint
CREATE TABLE "traffic_rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"direction" text NOT NULL,
	"resolution" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"bytes" bigint NOT NULL,
	"observed_seconds" integer NOT NULL,
	"gap_count" integer NOT NULL,
	"reset_count" integer NOT NULL,
	"estimated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_samples" ADD CONSTRAINT "client_samples_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_samples" ADD CONSTRAINT "client_samples_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_samples" ADD CONSTRAINT "client_samples_run_id_collector_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."collector_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_checkpoints" ADD CONSTRAINT "collector_checkpoints_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_checkpoints" ADD CONSTRAINT "collector_checkpoints_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_runs" ADD CONSTRAINT "collector_runs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traffic_intervals" ADD CONSTRAINT "traffic_intervals_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traffic_intervals" ADD CONSTRAINT "traffic_intervals_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traffic_intervals" ADD CONSTRAINT "traffic_intervals_sample_id_client_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."client_samples"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traffic_rollups" ADD CONSTRAINT "traffic_rollups_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traffic_rollups" ADD CONSTRAINT "traffic_rollups_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "samples_run_client_source_direction_key" ON "client_samples" USING btree ("run_id","client_id","source","direction");--> statement-breakpoint
CREATE INDEX "samples_client_time_idx" ON "client_samples" USING btree ("client_id","collected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_site_mac_key" ON "clients" USING btree ("site_id","mac");--> statement-breakpoint
CREATE INDEX "clients_updated_idx" ON "clients" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "checkpoints_client_source_direction_key" ON "collector_checkpoints" USING btree ("client_id","source","scope","direction");--> statement-breakpoint
CREATE INDEX "collector_runs_site_time_idx" ON "collector_runs" USING btree ("site_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_site_unifi_key" ON "devices" USING btree ("site_id","unifi_id");--> statement-breakpoint
CREATE INDEX "intervals_client_time_idx" ON "traffic_intervals" USING btree ("client_id","end_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rollups_client_bucket_key" ON "traffic_rollups" USING btree ("client_id","scope","direction","resolution","bucket_start");