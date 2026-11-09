CREATE TABLE "ingestion"."collector_resource_grant" (
	"credential_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"resource_kind" integer NOT NULL,
	CONSTRAINT "collector_resource_grant_credential_id_resource_id_pk" PRIMARY KEY("credential_id","resource_id"),
	CONSTRAINT "collector_resource_grant_resource" CHECK (app.collector_identifier_valid("ingestion"."collector_resource_grant"."resource_id") AND "ingestion"."collector_resource_grant"."resource_id" NOT LIKE 'recount.local.%' AND "ingestion"."collector_resource_grant"."resource_kind" BETWEEN 0 AND 8)
);
--> statement-breakpoint
CREATE TABLE "ingestion"."collector_root_grant" (
	"credential_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"resource_kind" integer NOT NULL,
	"adapter" text NOT NULL,
	"allowed_local_kinds" integer[] NOT NULL,
	CONSTRAINT "collector_root_grant_credential_id_resource_id_pk" PRIMARY KEY("credential_id","resource_id"),
	CONSTRAINT "collector_root_grant_resource" CHECK (app.collector_identifier_valid("ingestion"."collector_root_grant"."resource_id") AND "ingestion"."collector_root_grant"."resource_id" NOT LIKE 'recount.local.%' AND "ingestion"."collector_root_grant"."resource_kind" BETWEEN 0 AND 8),
	CONSTRAINT "collector_root_grant_adapter" CHECK ("ingestion"."collector_root_grant"."adapter" IN ('standard', 'linux') AND "ingestion"."collector_root_grant"."allowed_local_kinds" <@ ARRAY[2,3,4,6,8]::integer[] AND cardinality("ingestion"."collector_root_grant"."allowed_local_kinds") <= 5 AND ("ingestion"."collector_root_grant"."adapter" <> 'standard' OR cardinality("ingestion"."collector_root_grant"."allowed_local_kinds") = 0))
);
--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" DROP CONSTRAINT "collector_credential_hosts";--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" DROP CONSTRAINT "collector_credential_submission_age";--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" DROP CONSTRAINT "collector_credential_clock_skew";--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" ALTER COLUMN "maximum_submission_age" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" ALTER COLUMN "maximum_submission_age" SET DEFAULT 3600;--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" ALTER COLUMN "allowed_clock_skew" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" ALTER COLUMN "allowed_clock_skew" SET DEFAULT 60;--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" ADD COLUMN "root_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" ADD COLUMN "root_kind" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" ADD CONSTRAINT "collector_credential_tenant_key" UNIQUE("id","project_id","organization_id");--> statement-breakpoint
ALTER TABLE "ingestion"."collector_resource_grant" ADD CONSTRAINT "collector_resource_grant_tenant_fk" FOREIGN KEY ("credential_id","project_id","organization_id") REFERENCES "ingestion"."collector_credential"("id","project_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion"."collector_root_grant" ADD CONSTRAINT "collector_root_grant_tenant_fk" FOREIGN KEY ("credential_id","project_id","organization_id") REFERENCES "ingestion"."collector_credential"("id","project_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" DROP COLUMN "hosts";--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" DROP COLUMN "require_host_id";--> statement-breakpoint
DROP FUNCTION app.collector_hosts_valid(text[]);--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" ADD CONSTRAINT "collector_credential_root" CHECK (app.collector_identifier_valid("ingestion"."collector_credential"."root_id") AND "ingestion"."collector_credential"."root_id" NOT LIKE 'recount.local.%' AND "ingestion"."collector_credential"."root_kind" BETWEEN 0 AND 8);--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" ADD CONSTRAINT "collector_credential_submission_age" CHECK ("ingestion"."collector_credential"."maximum_submission_age" BETWEEN 1 AND 18446744073);--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" ADD CONSTRAINT "collector_credential_clock_skew" CHECK ("ingestion"."collector_credential"."allowed_clock_skew" >= 0 AND "ingestion"."collector_credential"."maximum_submission_age"::numeric + "ingestion"."collector_credential"."allowed_clock_skew"::numeric <= 18446744073);
