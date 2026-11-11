CREATE TABLE "ingestion"."collector_node" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"enrollment_key_id" uuid NOT NULL,
	"machine_id" text NOT NULL,
	"hostname" text NOT NULL,
	"public_key" text NOT NULL,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"collector_version" text DEFAULT '' NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "collector_node_machine" CHECK (app.collector_identifier_valid("ingestion"."collector_node"."machine_id") AND "ingestion"."collector_node"."machine_id" NOT LIKE 'recount.local.%'),
	CONSTRAINT "collector_node_hostname" CHECK (length(btrim("ingestion"."collector_node"."hostname")) BETWEEN 1 AND 255),
	CONSTRAINT "collector_node_public_key" CHECK ("ingestion"."collector_node"."public_key" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "collector_node_version" CHECK (length("ingestion"."collector_node"."collector_version") <= 64),
	CONSTRAINT "collector_node_deleted_revoked" CHECK ("ingestion"."collector_node"."deleted_at" IS NULL OR "ingestion"."collector_node"."revoked_at" IS NOT NULL),
	CONSTRAINT "collector_node_labels" CHECK (cardinality("ingestion"."collector_node"."labels") <= 20 AND array_position("ingestion"."collector_node"."labels", NULL) IS NULL)
);
--> statement-breakpoint
CREATE TABLE "ingestion"."enrollment_key" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_sha256" text NOT NULL,
	"adapter" text DEFAULT 'linux' NOT NULL,
	"allowed_local_kinds" integer[] DEFAULT ARRAY[4,6]::integer[] NOT NULL,
	"maximum_submission_age" bigint DEFAULT 3600 NOT NULL,
	"allowed_clock_skew" bigint DEFAULT 60 NOT NULL,
	"max_nodes" integer,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "enrollment_key_key_sha256_unique" UNIQUE("key_sha256"),
	CONSTRAINT "enrollment_key_tenant_key" UNIQUE("id","project_id","organization_id"),
	CONSTRAINT "enrollment_key_digest" CHECK ("ingestion"."enrollment_key"."key_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "enrollment_key_name" CHECK (length(btrim("ingestion"."enrollment_key"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "enrollment_key_adapter" CHECK ("ingestion"."enrollment_key"."adapter" IN ('standard', 'linux') AND "ingestion"."enrollment_key"."allowed_local_kinds" <@ ARRAY[2,3,4,6,8]::integer[] AND cardinality("ingestion"."enrollment_key"."allowed_local_kinds") <= 5 AND ("ingestion"."enrollment_key"."adapter" <> 'standard' OR cardinality("ingestion"."enrollment_key"."allowed_local_kinds") = 0)),
	CONSTRAINT "enrollment_key_submission_age" CHECK ("ingestion"."enrollment_key"."maximum_submission_age" BETWEEN 1 AND 18446744073),
	CONSTRAINT "enrollment_key_clock_skew" CHECK ("ingestion"."enrollment_key"."allowed_clock_skew" >= 0 AND "ingestion"."enrollment_key"."maximum_submission_age"::numeric + "ingestion"."enrollment_key"."allowed_clock_skew"::numeric <= 18446744073),
	CONSTRAINT "enrollment_key_max_nodes" CHECK ("ingestion"."enrollment_key"."max_nodes" IS NULL OR "ingestion"."enrollment_key"."max_nodes" BETWEEN 1 AND 1000000),
	CONSTRAINT "enrollment_key_labels" CHECK (cardinality("ingestion"."enrollment_key"."labels") <= 20 AND array_position("ingestion"."enrollment_key"."labels", NULL) IS NULL),
	CONSTRAINT "enrollment_key_expiration" CHECK ("ingestion"."enrollment_key"."expires_at" IS NULL OR "ingestion"."enrollment_key"."expires_at" > "ingestion"."enrollment_key"."created_at")
);
--> statement-breakpoint
DROP TABLE "ingestion"."collector_credential" CASCADE;--> statement-breakpoint
DROP TABLE "ingestion"."collector_resource_grant" CASCADE;--> statement-breakpoint
DROP TABLE "ingestion"."collector_root_grant" CASCADE;--> statement-breakpoint
ALTER TABLE "ingestion"."collector_node" ADD CONSTRAINT "collector_node_enrollment_key_fk" FOREIGN KEY ("enrollment_key_id","project_id","organization_id") REFERENCES "ingestion"."enrollment_key"("id","project_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion"."enrollment_key" ADD CONSTRAINT "enrollment_key_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "app"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collector_node_active_machine" ON "ingestion"."collector_node" USING btree ("project_id","machine_id") WHERE "ingestion"."collector_node"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "collector_node_project_idx" ON "ingestion"."collector_node" USING btree ("project_id","organization_id");--> statement-breakpoint
CREATE INDEX "collector_node_revoked_idx" ON "ingestion"."collector_node" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "enrollment_key_project_idx" ON "ingestion"."enrollment_key" USING btree ("project_id","organization_id");