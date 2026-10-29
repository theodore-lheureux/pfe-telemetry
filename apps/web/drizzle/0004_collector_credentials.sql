-- Match Rust's UTF-8 byte limit and Unicode control-character exclusion without locale-dependent character classes.
CREATE FUNCTION app.collector_identifier_valid(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
	SELECT value IS NOT NULL AND octet_length(value) BETWEEN 1 AND 128
		AND NOT EXISTS (
			SELECT 1 FROM generate_series(1, length(value)) AS position
			WHERE ascii(substr(value, position, 1)) BETWEEN 0 AND 31
				OR ascii(substr(value, position, 1)) BETWEEN 127 AND 159
		);
$$;
--> statement-breakpoint
CREATE FUNCTION app.collector_hosts_valid(hosts text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
	SELECT hosts IS NOT NULL AND cardinality(hosts) <= 256
		AND (cardinality(hosts) = 0 OR (array_ndims(hosts) = 1 AND array_lower(hosts, 1) = 1))
		AND NOT EXISTS (SELECT 1 FROM unnest(hosts) AS host WHERE NOT app.collector_identifier_valid(host))
		AND cardinality(hosts) = (SELECT count(DISTINCT host) FROM unnest(hosts) AS host);
$$;
--> statement-breakpoint
CREATE SCHEMA "ingestion";
--> statement-breakpoint
CREATE TABLE "ingestion"."collector_credential" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"token_sha256" text NOT NULL,
	"hosts" text[] NOT NULL,
	"require_host_id" boolean DEFAULT true NOT NULL,
	"maximum_submission_age" integer DEFAULT 3600 NOT NULL,
	"allowed_clock_skew" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "collector_credential_token_sha256_unique" UNIQUE("token_sha256"),
	CONSTRAINT "collector_credential_digest" CHECK ("ingestion"."collector_credential"."token_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "collector_credential_name" CHECK (length(btrim("ingestion"."collector_credential"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "collector_credential_source" CHECK (app.collector_identifier_valid("ingestion"."collector_credential"."source_id")),
	CONSTRAINT "collector_credential_hosts" CHECK (app.collector_hosts_valid("ingestion"."collector_credential"."hosts") AND (NOT "ingestion"."collector_credential"."require_host_id" OR cardinality("ingestion"."collector_credential"."hosts") > 0)),
	CONSTRAINT "collector_credential_submission_age" CHECK ("ingestion"."collector_credential"."maximum_submission_age" BETWEEN 1 AND 86400),
	CONSTRAINT "collector_credential_clock_skew" CHECK ("ingestion"."collector_credential"."allowed_clock_skew" BETWEEN 1 AND 3600),
	CONSTRAINT "collector_credential_expiration" CHECK ("ingestion"."collector_credential"."expires_at" IS NULL OR "ingestion"."collector_credential"."expires_at" > "ingestion"."collector_credential"."created_at")
);
--> statement-breakpoint
ALTER TABLE "ingestion"."collector_credential" ADD CONSTRAINT "collector_credential_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "app"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collector_credential_project_idx" ON "ingestion"."collector_credential" USING btree ("project_id","organization_id");
