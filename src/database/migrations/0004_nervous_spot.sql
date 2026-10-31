DROP INDEX "rate_limit_lookup_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limit_bucket_unq" ON "rate_limits" USING btree ("subject","bucket","window_start");