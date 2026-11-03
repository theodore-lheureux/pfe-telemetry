CREATE TYPE "app"."project_role" AS ENUM('viewer', 'member', 'admin');--> statement-breakpoint
CREATE TABLE "app"."invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "member_organization_user_unique" UNIQUE("organization_id","user_id"),
	CONSTRAINT "member_id_organization_unique" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "app"."organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "app"."organization_owner_guard" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"owner_count" integer NOT NULL,
	CONSTRAINT "organization_must_retain_owner" CHECK ("app"."organization_owner_guard"."owner_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_organization_slug_unique" UNIQUE("organization_id","slug"),
	CONSTRAINT "project_id_organization_unique" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "app"."project_member" (
	"project_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"member_id" text NOT NULL,
	"role" "app"."project_role" NOT NULL,
	CONSTRAINT "project_member_project_id_member_id_pk" PRIMARY KEY("project_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "app"."session" ADD COLUMN "active_organization_id" text;--> statement-breakpoint
ALTER TABLE "app"."invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "app"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."organization_owner_guard" ADD CONSTRAINT "organization_owner_guard_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project" ADD CONSTRAINT "project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project" ADD CONSTRAINT "project_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_member" ADD CONSTRAINT "project_member_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "app"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_member" ADD CONSTRAINT "project_member_member_organization_fk" FOREIGN KEY ("member_id","organization_id") REFERENCES "app"."member"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "app"."invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "app"."invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "app"."member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "app"."member" USING btree ("user_id");