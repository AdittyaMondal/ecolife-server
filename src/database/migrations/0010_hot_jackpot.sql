ALTER TYPE "public"."event_visibility" ADD VALUE 'organization_only';--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "organization_id" bigint;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "venue_map_url" text;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;