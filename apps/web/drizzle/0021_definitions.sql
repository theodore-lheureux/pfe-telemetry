CREATE TYPE "app"."attribute_scope" AS ENUM('point', 'resource');--> statement-breakpoint
CREATE TYPE "app"."definition_status" AS ENUM('verified', 'hidden');--> statement-breakpoint
CREATE TABLE "app"."attribute_annotation" (
	"project_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"scope" "app"."attribute_scope" NOT NULL,
	"attribute_key" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "app"."definition_status",
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attribute_annotation_pk" PRIMARY KEY("project_id","scope","attribute_key"),
	CONSTRAINT "attribute_annotation_key_bounded" CHECK (char_length("app"."attribute_annotation"."attribute_key") BETWEEN 1 AND 255),
	CONSTRAINT "attribute_annotation_description_bounded" CHECK (char_length("app"."attribute_annotation"."description") <= 1000),
	CONSTRAINT "attribute_annotation_tags_bounded" CHECK (cardinality("app"."attribute_annotation"."tags") <= 20 AND array_position("app"."attribute_annotation"."tags", NULL) IS NULL)
);
--> statement-breakpoint
CREATE TABLE "app"."metric_annotation" (
	"project_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"metric_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "app"."definition_status",
	"owner_id" text,
	"default_breakdown" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_annotation_pk" PRIMARY KEY("project_id","metric_name"),
	CONSTRAINT "metric_annotation_name_bounded" CHECK (char_length("app"."metric_annotation"."metric_name") BETWEEN 1 AND 255),
	CONSTRAINT "metric_annotation_description_bounded" CHECK (char_length("app"."metric_annotation"."description") <= 1000),
	CONSTRAINT "metric_annotation_tags_bounded" CHECK (cardinality("app"."metric_annotation"."tags") <= 20 AND array_position("app"."metric_annotation"."tags", NULL) IS NULL),
	CONSTRAINT "metric_annotation_breakdown_bounded" CHECK (char_length("app"."metric_annotation"."default_breakdown") <= 300)
);
--> statement-breakpoint
ALTER TABLE "app"."attribute_annotation" ADD CONSTRAINT "attribute_annotation_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "app"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."attribute_annotation" ADD CONSTRAINT "attribute_annotation_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "app"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."metric_annotation" ADD CONSTRAINT "metric_annotation_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."metric_annotation" ADD CONSTRAINT "metric_annotation_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "app"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."metric_annotation" ADD CONSTRAINT "metric_annotation_project_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "app"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;