CREATE TABLE "agent_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"client_id" uuid,
	"bucket_start" timestamp with time zone NOT NULL,
	"scope" text NOT NULL,
	"direction" text NOT NULL,
	"bytes" bigint NOT NULL,
	"coverage_seconds" integer NOT NULL,
	"final" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_status" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"connected" boolean DEFAULT false NOT NULL,
	"agent_id" text,
	"agent_version" text,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"last_frame_at" timestamp with time zone,
	"last_final_bucket" timestamp with time zone,
	"earliest_available" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_buckets" ADD CONSTRAINT "agent_buckets_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_buckets" ADD CONSTRAINT "agent_buckets_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_status" ADD CONSTRAINT "agent_status_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_buckets_key" ON "agent_buckets" USING btree ("site_id","subject","bucket_start","scope","direction");--> statement-breakpoint
CREATE INDEX "agent_buckets_final_idx" ON "agent_buckets" USING btree ("site_id","final","bucket_start");--> statement-breakpoint
CREATE INDEX "agent_buckets_unresolved_idx" ON "agent_buckets" USING btree ("site_id","bucket_start") WHERE client_id IS NULL;