ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_unq" ON "users" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_registrations_within_capacity" CHECK ("events"."registered_count" <= "events"."capacity");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_checkins_within_registrations" CHECK ("events"."checked_in_count" <= "events"."registered_count");