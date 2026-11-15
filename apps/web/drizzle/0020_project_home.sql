CREATE TABLE "app"."project_home" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."project_home" ADD CONSTRAINT "project_home_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "app"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_home" ADD CONSTRAINT "project_home_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "app"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_home" ADD CONSTRAINT "project_home_dashboard_fk" FOREIGN KEY ("dashboard_id","project_id") REFERENCES "app"."dashboard"("id","project_id") ON DELETE cascade ON UPDATE no action;