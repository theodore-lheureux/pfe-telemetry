CREATE UNLOGGED TABLE "app"."analytics_slot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "analytics_slot_organization_idx" ON "app"."analytics_slot" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "app"."rate_limit" SET UNLOGGED;