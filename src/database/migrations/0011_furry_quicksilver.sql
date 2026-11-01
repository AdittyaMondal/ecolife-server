CREATE TYPE "public"."discount_type" AS ENUM('none', 'percentage', 'fixed');--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "seller_org_id" bigint;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "status" "order_status" DEFAULT 'placed' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "images" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_type" "discount_type" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_value" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_start_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "discount_end_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "allow_coin_redemption" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "max_coin_redemption_percent" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_seller_org_id_organizations_id_fk" FOREIGN KEY ("seller_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_items_seller_idx" ON "order_items" USING btree ("seller_org_id","status");--> statement-breakpoint
CREATE INDEX "products_seller_idx" ON "products" USING btree ("seller_org_id","is_active");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_discount_value_non_negative" CHECK ("products"."discount_value" >= 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_max_coins_pct_valid" CHECK ("products"."max_coin_redemption_percent" >= 0 AND "products"."max_coin_redemption_percent" <= 100);