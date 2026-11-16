CREATE TABLE "app"."calculated_metric" (
	"id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calculated_metric_project_id_id_pk" PRIMARY KEY("project_id","id"),
	CONSTRAINT "calculated_metric_name_bounded" CHECK (char_length("app"."calculated_metric"."name") BETWEEN 1 AND 120),
	CONSTRAINT "calculated_metric_description_bounded" CHECK (char_length("app"."calculated_metric"."description") <= 1000),
	CONSTRAINT "calculated_metric_definition_bounded" CHECK (jsonb_typeof("app"."calculated_metric"."definition") = 'object' AND octet_length("app"."calculated_metric"."definition"::text) <= 16384)
);
--> statement-breakpoint
ALTER TABLE "app"."calculated_metric" ADD CONSTRAINT "calculated_metric_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calculated_metric" ADD CONSTRAINT "calculated_metric_project_id_organization_id_project_id_organization_id_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "app"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;