CREATE TABLE "app"."explorer_column_default" (
	"project_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"columns" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "explorer_column_default_project_id_organization_id_pk" PRIMARY KEY("project_id","organization_id"),
	CONSTRAINT "explorer_column_default_bounded" CHECK (jsonb_typeof("app"."explorer_column_default"."columns") = 'array' AND jsonb_array_length("app"."explorer_column_default"."columns") BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE TABLE "app"."explorer_column_preference" (
	"project_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"member_id" text NOT NULL,
	"columns" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "explorer_column_preference_project_id_member_id_pk" PRIMARY KEY("project_id","member_id"),
	CONSTRAINT "explorer_column_preference_bounded" CHECK (jsonb_typeof("app"."explorer_column_preference"."columns") = 'array' AND jsonb_array_length("app"."explorer_column_preference"."columns") BETWEEN 1 AND 20)
);
--> statement-breakpoint
ALTER TABLE "app"."explorer_column_default" ADD CONSTRAINT "explorer_column_default_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "app"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."explorer_column_preference" ADD CONSTRAINT "explorer_column_preference_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "app"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."explorer_column_preference" ADD CONSTRAINT "explorer_column_preference_member_fk" FOREIGN KEY ("member_id","organization_id") REFERENCES "app"."member"("id","organization_id") ON DELETE cascade ON UPDATE no action;