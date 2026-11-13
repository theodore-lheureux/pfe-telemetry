ALTER TABLE "app"."saved_insight" ADD CONSTRAINT "saved_insight_id_project_unique" UNIQUE("id","project_id");--> statement-breakpoint
CREATE TABLE "app"."dashboard" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_id_project_unique" UNIQUE("id","project_id"),
	CONSTRAINT "dashboard_name_bounded" CHECK (char_length("app"."dashboard"."name") BETWEEN 1 AND 120),
	CONSTRAINT "dashboard_description_bounded" CHECK (char_length("app"."dashboard"."description") <= 1000),
	CONSTRAINT "dashboard_filters_bounded" CHECK (jsonb_typeof("app"."dashboard"."filters") = 'object' AND octet_length("app"."dashboard"."filters"::text) <= 8192)
);
--> statement-breakpoint
CREATE TABLE "app"."dashboard_tile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"insight_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"width" smallint NOT NULL,
	"height" smallint NOT NULL,
	"column" smallint,
	CONSTRAINT "dashboard_tile_width_valid" CHECK ("app"."dashboard_tile"."width" BETWEEN 3 AND 12),
	CONSTRAINT "dashboard_tile_height_valid" CHECK ("app"."dashboard_tile"."height" BETWEEN 1 AND 6),
	CONSTRAINT "dashboard_tile_column_valid" CHECK ("app"."dashboard_tile"."column" IS NULL OR ("app"."dashboard_tile"."column" >= 1 AND "app"."dashboard_tile"."column" + "app"."dashboard_tile"."width" <= 13))
);
--> statement-breakpoint
ALTER TABLE "app"."dashboard" ADD CONSTRAINT "dashboard_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard" ADD CONSTRAINT "dashboard_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "app"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard" ADD CONSTRAINT "dashboard_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "app"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard_tile" ADD CONSTRAINT "dashboard_tile_dashboard_fk" FOREIGN KEY ("dashboard_id","project_id") REFERENCES "app"."dashboard"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard_tile" ADD CONSTRAINT "dashboard_tile_insight_fk" FOREIGN KEY ("insight_id","project_id") REFERENCES "app"."saved_insight"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_project_updated_idx" ON "app"."dashboard" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "dashboard_tile_dashboard_idx" ON "app"."dashboard_tile" USING btree ("dashboard_id","position");--> statement-breakpoint
CREATE INDEX "dashboard_tile_insight_idx" ON "app"."dashboard_tile" USING btree ("insight_id");