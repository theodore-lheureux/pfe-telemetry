CREATE TABLE "app"."dashboard_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_template_definition_bounded" CHECK (jsonb_typeof("app"."dashboard_template"."definition") = 'object' AND octet_length("app"."dashboard_template"."definition"::text) <= 524288)
);
--> statement-breakpoint
ALTER TABLE "app"."dashboard_template" ADD CONSTRAINT "dashboard_template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."dashboard_template" ADD CONSTRAINT "dashboard_template_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "app"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_template_project_idx" ON "app"."dashboard_template" USING btree ("project_id");