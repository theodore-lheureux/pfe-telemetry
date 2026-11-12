CREATE TABLE "app"."saved_insight" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"draft" jsonb NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_insight_name_bounded" CHECK (char_length("app"."saved_insight"."name") BETWEEN 1 AND 120),
	CONSTRAINT "saved_insight_tags_bounded" CHECK (cardinality("app"."saved_insight"."tags") <= 20 AND array_position("app"."saved_insight"."tags", NULL) IS NULL),
	CONSTRAINT "saved_insight_description_bounded" CHECK (char_length("app"."saved_insight"."description") <= 1000),
	CONSTRAINT "saved_insight_draft_bounded" CHECK (jsonb_typeof("app"."saved_insight"."draft") = 'object' AND octet_length("app"."saved_insight"."draft"::text) <= 32768)
);
--> statement-breakpoint
ALTER TABLE "app"."saved_insight" ADD CONSTRAINT "saved_insight_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."saved_insight" ADD CONSTRAINT "saved_insight_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "app"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."saved_insight" ADD CONSTRAINT "saved_insight_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "app"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_insight_project_updated_idx" ON "app"."saved_insight" USING btree ("project_id","updated_at");