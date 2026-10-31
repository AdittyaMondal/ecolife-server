CREATE TABLE "rate_limits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_lookup_idx" ON "rate_limits" USING btree ("subject","bucket","window_start");