ALTER TABLE "organizations" ADD COLUMN "code" text;--> statement-breakpoint
UPDATE "organizations" SET "code" = LPAD(FLOOR(RANDOM() * 900000 + 100000)::text, 6, '0') WHERE "code" IS NULL;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_code_unique" UNIQUE("code");