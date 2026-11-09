ALTER TABLE "app"."project" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."project" ADD COLUMN "project_group" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."project" ADD COLUMN "time_zone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."project" ADD COLUMN "week_starts_on" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."project" ADD CONSTRAINT "project_tags_bounded" CHECK (cardinality("app"."project"."tags") <= 20 AND array_position("app"."project"."tags", NULL) IS NULL);--> statement-breakpoint
ALTER TABLE "app"."project" ADD CONSTRAINT "project_group_bounded" CHECK (length("app"."project"."project_group") <= 80);--> statement-breakpoint
ALTER TABLE "app"."project" ADD CONSTRAINT "project_time_zone_bounded" CHECK (length("app"."project"."time_zone") BETWEEN 1 AND 100);--> statement-breakpoint
ALTER TABLE "app"."project" ADD CONSTRAINT "project_week_start_valid" CHECK ("app"."project"."week_starts_on" BETWEEN 0 AND 6);