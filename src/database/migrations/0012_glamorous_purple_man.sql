CREATE TYPE "public"."payout_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('pending', 'settled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."settlement_transaction_type" AS ENUM('sale_commission', 'coin_subsidy', 'coin_fee', 'seller_payout');--> statement-breakpoint
CREATE TABLE "order_settlements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_id" bigint NOT NULL,
	"order_item_id" bigint NOT NULL,
	"seller_org_id" bigint NOT NULL,
	"sale_amount_paise" integer NOT NULL,
	"coins_used" integer DEFAULT 0 NOT NULL,
	"coin_value_paise" integer DEFAULT 0 NOT NULL,
	"cash_paid_paise" integer NOT NULL,
	"commission_rate_bps" integer NOT NULL,
	"sales_commission_paise" integer NOT NULL,
	"coin_fee_rate_bps" integer NOT NULL,
	"coin_fee_paise" integer NOT NULL,
	"platform_commission_paise" integer NOT NULL,
	"seller_payout_paise" integer NOT NULL,
	"status" "settlement_status" DEFAULT 'pending' NOT NULL,
	"payout_id" bigint,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_conservation_of_money" CHECK ("order_settlements"."seller_payout_paise" + "order_settlements"."platform_commission_paise" = "order_settlements"."sale_amount_paise"),
	CONSTRAINT "settlement_customer_funding" CHECK ("order_settlements"."cash_paid_paise" + "order_settlements"."coin_value_paise" = "order_settlements"."sale_amount_paise"),
	CONSTRAINT "settlement_commission_sum" CHECK ("order_settlements"."platform_commission_paise" = "order_settlements"."sales_commission_paise" + "order_settlements"."coin_fee_paise"),
	CONSTRAINT "settlement_non_negative" CHECK ("order_settlements"."sale_amount_paise" >= 0 AND "order_settlements"."cash_paid_paise" >= 0 AND "order_settlements"."coin_value_paise" >= 0 AND "order_settlements"."platform_commission_paise" >= 0 AND "order_settlements"."seller_payout_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "seller_payouts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"payout_number" text NOT NULL,
	"seller_org_id" bigint NOT NULL,
	"total_amount_paise" integer NOT NULL,
	"settlement_count" integer NOT NULL,
	"status" "payout_status" DEFAULT 'completed' NOT NULL,
	"reference_note" text,
	"processed_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_payouts_payout_number_unique" UNIQUE("payout_number"),
	CONSTRAINT "seller_payouts_amount_positive" CHECK ("seller_payouts"."total_amount_paise" >= 0),
	CONSTRAINT "seller_payouts_count_positive" CHECK ("seller_payouts"."settlement_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "settlement_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"settlement_id" bigint,
	"order_id" bigint NOT NULL,
	"order_item_id" bigint,
	"seller_org_id" bigint NOT NULL,
	"transaction_type" "settlement_transaction_type" NOT NULL,
	"amount_paise" integer NOT NULL,
	"status" "settlement_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"default_commission_rate_bps" integer DEFAULT 1000 NOT NULL,
	"coin_redemption_fee_bps" integer DEFAULT 200 NOT NULL,
	"coins_per_rupee" integer DEFAULT 10 NOT NULL,
	"coin_value_paise" integer DEFAULT 10 NOT NULL,
	"max_discount_percent" integer DEFAULT 20 NOT NULL,
	"payout_hold_days" integer DEFAULT 7 NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_settings_singleton" CHECK ("system_settings"."id" = 1),
	CONSTRAINT "system_settings_commission_range" CHECK ("system_settings"."default_commission_rate_bps" >= 0 AND "system_settings"."default_commission_rate_bps" <= 5000),
	CONSTRAINT "system_settings_coin_fee_range" CHECK ("system_settings"."coin_redemption_fee_bps" >= 0 AND "system_settings"."coin_redemption_fee_bps" <= 2000),
	CONSTRAINT "system_settings_coins_rate_positive" CHECK ("system_settings"."coins_per_rupee" > 0 AND "system_settings"."coin_value_paise" > 0),
	CONSTRAINT "system_settings_max_discount_range" CHECK ("system_settings"."max_discount_percent" >= 0 AND "system_settings"."max_discount_percent" <= 100)
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "commission_rate_bps" integer;--> statement-breakpoint
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_seller_org_id_organizations_id_fk" FOREIGN KEY ("seller_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_settlements" ADD CONSTRAINT "order_settlements_payout_id_seller_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."seller_payouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_payouts" ADD CONSTRAINT "seller_payouts_seller_org_id_organizations_id_fk" FOREIGN KEY ("seller_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_payouts" ADD CONSTRAINT "seller_payouts_processed_by_users_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_ledger" ADD CONSTRAINT "settlement_ledger_settlement_id_order_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."order_settlements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_ledger" ADD CONSTRAINT "settlement_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_ledger" ADD CONSTRAINT "settlement_ledger_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_ledger" ADD CONSTRAINT "settlement_ledger_seller_org_id_organizations_id_fk" FOREIGN KEY ("seller_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_settlement_item_unq" ON "order_settlements" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "order_settlements_seller_status_idx" ON "order_settlements" USING btree ("seller_org_id","status");--> statement-breakpoint
CREATE INDEX "order_settlements_order_idx" ON "order_settlements" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "seller_payouts_seller_idx" ON "seller_payouts" USING btree ("seller_org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_ledger_idempotency_unq" ON "settlement_ledger" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "settlement_ledger_seller_type_idx" ON "settlement_ledger" USING btree ("seller_org_id","transaction_type","created_at");--> statement-breakpoint
CREATE INDEX "settlement_ledger_order_idx" ON "settlement_ledger" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "org_commission_bps_valid" CHECK ("organizations"."commission_rate_bps" IS NULL OR ("organizations"."commission_rate_bps" >= 0 AND "organizations"."commission_rate_bps" <= 5000));