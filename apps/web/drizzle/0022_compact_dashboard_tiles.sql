ALTER TABLE "app"."dashboard_tile" DROP CONSTRAINT "dashboard_tile_width_valid";--> statement-breakpoint
ALTER TABLE "app"."dashboard_tile" DROP CONSTRAINT "dashboard_tile_height_valid";--> statement-breakpoint
ALTER TABLE "app"."dashboard_tile" ADD CONSTRAINT "dashboard_tile_width_valid" CHECK ("app"."dashboard_tile"."width" BETWEEN 2 AND 12);--> statement-breakpoint
ALTER TABLE "app"."dashboard_tile" ADD CONSTRAINT "dashboard_tile_height_valid" CHECK ("app"."dashboard_tile"."height" BETWEEN 0 AND 6);