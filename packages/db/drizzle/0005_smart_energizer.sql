ALTER TABLE "clients" ADD COLUMN "wireless_signal_dbm" integer;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "wireless_noise_dbm" integer;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "wireless_observed_at" timestamp with time zone;