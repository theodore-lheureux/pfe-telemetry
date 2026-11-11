ALTER TABLE "app"."project" DROP CONSTRAINT "project_organization_slug_unique";--> statement-breakpoint
ALTER TABLE "app"."project" DROP CONSTRAINT "project_week_start_valid";--> statement-breakpoint
ALTER TABLE "app"."project" DROP COLUMN "slug";--> statement-breakpoint
ALTER TABLE "app"."project" ADD CONSTRAINT "project_week_start_valid" CHECK ("app"."project"."week_starts_on" IN (0, 1));