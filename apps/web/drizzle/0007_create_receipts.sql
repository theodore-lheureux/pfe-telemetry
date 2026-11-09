CREATE TABLE "app"."create_receipt" (
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid,
	"input_hash" text NOT NULL,
	"resource_id" uuid NOT NULL,
	CONSTRAINT "create_receipt_actor_id_request_id_pk" PRIMARY KEY("actor_id","request_id"),
	CONSTRAINT "create_receipt_operation_scope" CHECK (("app"."create_receipt"."operation" = 'create-project' AND "app"."create_receipt"."project_id" IS NULL) OR ("app"."create_receipt"."operation" = 'create-execution' AND "app"."create_receipt"."project_id" IS NOT NULL)),
	CONSTRAINT "create_receipt_input_hash" CHECK ("app"."create_receipt"."input_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "app"."create_receipt" ADD CONSTRAINT "create_receipt_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "app"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."create_receipt" ADD CONSTRAINT "create_receipt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."create_receipt" ADD CONSTRAINT "create_receipt_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "app"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;