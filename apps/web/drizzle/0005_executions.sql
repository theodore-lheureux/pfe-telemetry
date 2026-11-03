CREATE TABLE "app"."execution" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_id" text NOT NULL,
	"host_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_name" CHECK (length(btrim("app"."execution"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "execution_window" CHECK ("app"."execution"."started_at" >= timestamptz '1970-01-01' AND "app"."execution"."ended_at" <= timestamptz '2101-01-01' AND "app"."execution"."ended_at" > "app"."execution"."started_at" AND "app"."execution"."ended_at" <= "app"."execution"."started_at" + interval '7 days'),
	CONSTRAINT "execution_source" CHECK (app.collector_identifier_valid("app"."execution"."source_id")),
	CONSTRAINT "execution_host" CHECK ("app"."execution"."host_id" IS NULL OR app.collector_identifier_valid("app"."execution"."host_id"))
);
--> statement-breakpoint
ALTER TABLE "app"."execution" ADD CONSTRAINT "execution_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."execution" ADD CONSTRAINT "execution_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "app"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_project_id_idx" ON "app"."execution" USING btree ("project_id","id");