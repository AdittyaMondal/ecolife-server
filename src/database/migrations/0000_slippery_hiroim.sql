CREATE TYPE "public"."ac_hours_bucket" AS ENUM('0', '1_3', '4_8', '8_plus');--> statement-breakpoint
CREATE TYPE "public"."bath_choice" AS ENUM('bucket', 'short_shower', 'long_shower');--> statement-breakpoint
CREATE TYPE "public"."commute_mode" AS ENUM('walk', 'cycle', 'bus', 'metro_train', 'two_wheeler', 'car', 'cab', 'auto_rickshaw', 'work_from_home');--> statement-breakpoint
CREATE TYPE "public"."cooking_fuel" AS ENUM('lpg', 'png', 'electric_induction', 'firewood');--> statement-breakpoint
CREATE TYPE "public"."cooling_usage" AS ENUM('none', 'fan_only', 'ac_occasional', 'ac_daily');--> statement-breakpoint
CREATE TYPE "public"."diet_type" AS ENUM('vegan', 'vegetarian', 'eggetarian', 'non_veg_weekly', 'non_veg_daily');--> statement-breakpoint
CREATE TYPE "public"."emission_category" AS ENUM('transport', 'food', 'home_energy', 'water', 'waste');--> statement-breakpoint
CREATE TYPE "public"."event_role" AS ENUM('host', 'co_host');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('draft', 'published', 'ongoing', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('plant_drive', 'cleanup_drive', 'awareness', 'recycling_drive', 'workshop', 'other');--> statement-breakpoint
CREATE TYPE "public"."event_visibility" AS ENUM('public', 'invite_only');--> statement-breakpoint
CREATE TYPE "public"."freq3" AS ENUM('rarely', 'sometimes', 'often');--> statement-breakpoint
CREATE TYPE "public"."goal_period" AS ENUM('week', 'month', 'quarter');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('active', 'achieved', 'missed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."goal_type" AS ENUM('reduce_percent', 'absolute_cap');--> statement-breakpoint
CREATE TYPE "public"."kwh_source" AS ENUM('reported', 'from_bill', 'estimated');--> statement-breakpoint
CREATE TYPE "public"."level3" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('placed', 'confirmed', 'shipped', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."pass_status" AS ENUM('registered', 'checked_in', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."product_category" AS ENUM('plants', 'household', 'personal_care', 'kitchen', 'stationery');--> statement-breakpoint
CREATE TYPE "public"."reward_source" AS ENUM('onboarding', 'daily_log', 'streak', 'reduction', 'goal', 'event_attend', 'event_host', 'order', 'order_refund', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."vehicle_fuel" AS ENUM('petrol', 'diesel', 'cng', 'electric', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."waste_habit" AS ENUM('segregate_and_compost', 'segregate_only', 'none');--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"pincode" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_user_id" bigint,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"old_values" jsonb,
	"new_values" jsonb,
	"ip_address" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"user_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_user_id_product_id_pk" PRIMARY KEY("user_id","product_id"),
	CONSTRAINT "cart_qty_positive" CHECK ("cart_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "cities" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"region_code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_footprints" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"log_date" date NOT NULL,
	"daily_log_id" bigint,
	"transport_kg" double precision DEFAULT 0 NOT NULL,
	"food_kg" double precision DEFAULT 0 NOT NULL,
	"home_energy_kg" double precision DEFAULT 0 NOT NULL,
	"water_kg" double precision DEFAULT 0 NOT NULL,
	"waste_kg" double precision DEFAULT 0 NOT NULL,
	"total_kg" double precision DEFAULT 0 NOT NULL,
	"baseline_total_kg" double precision NOT NULL,
	"reduction_pct" double precision DEFAULT 0 NOT NULL,
	"sources" jsonb NOT NULL,
	"clamped" boolean DEFAULT false NOT NULL,
	"factor_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"log_date" date NOT NULL,
	"client_log_id" text NOT NULL,
	"trips" jsonb,
	"veg_meals" integer,
	"non_veg_meals" integer,
	"vegan_meals" integer,
	"ac_hours_bucket" "ac_hours_bucket",
	"bath_choice" "bath_choice",
	"waste_actions" jsonb,
	"answered_count" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_hosts" (
	"event_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"role" text DEFAULT 'co_host' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_passes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"pass_code_hash" text NOT NULL,
	"status" "pass_status" DEFAULT 'registered' NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_in_at" timestamp with time zone,
	"checked_in_by" bigint,
	"scan_client_id" text,
	CONSTRAINT "event_passes_pass_code_hash_unique" UNIQUE("pass_code_hash")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"type" "event_type" NOT NULL,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"visibility" "event_visibility" DEFAULT 'public' NOT NULL,
	"cover_url" text,
	"host_id" bigint NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"venue_name" text NOT NULL,
	"venue_address" text,
	"latitude" double precision,
	"longitude" double precision,
	"capacity" integer DEFAULT 100 NOT NULL,
	"registered_count" integer DEFAULT 0 NOT NULL,
	"checked_in_count" integer DEFAULT 0 NOT NULL,
	"flagged_for_review" boolean DEFAULT false NOT NULL,
	"host_rewarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_slug_unique" UNIQUE("slug"),
	CONSTRAINT "events_end_after_start" CHECK ("events"."end_at" > "events"."start_at"),
	CONSTRAINT "events_capacity_positive" CHECK ("events"."capacity" > 0),
	CONSTRAINT "events_checkins_within_capacity" CHECK ("events"."checked_in_count" <= "events"."capacity")
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"type" "goal_type" NOT NULL,
	"period" "goal_period" NOT NULL,
	"reduce_percent" double precision,
	"cap_kg_per_day" double precision,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"baseline_kg_total" double precision NOT NULL,
	"target_kg_total" double precision NOT NULL,
	"status" "goal_status" DEFAULT 'active' NOT NULL,
	"actual_kg_total" double precision,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_end_after_start" CHECK ("goals"."end_date" > "goals"."start_date"),
	CONSTRAINT "goals_target_non_negative" CHECK ("goals"."target_kg_total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lifestyle_profiles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"household_size" integer,
	"city" text,
	"region_code" text,
	"cooling_usage" "cooling_usage",
	"diet_type" "diet_type",
	"food_waste_level" "level3",
	"packaged_food_freq" "freq3",
	"primary_commute_mode" "commute_mode",
	"vehicle_fuel" "vehicle_fuel",
	"commute_distance_km" double precision,
	"flights_per_year" integer,
	"electricity_kwh_month" double precision,
	"electricity_bill_inr" integer,
	"kwh_source" "kwh_source",
	"cooking_fuel" "cooking_fuel",
	"has_solar" boolean,
	"water_usage_level" "level3",
	"waste_habit" "waste_habit",
	"baseline_transport_kg" double precision,
	"baseline_food_kg" double precision,
	"baseline_home_energy_kg" double precision,
	"baseline_water_kg" double precision,
	"baseline_waste_kg" double precision,
	"baseline_total_kg" double precision,
	"baseline_flight_kg" double precision,
	"baseline_cook_kg" double precision,
	"baseline_grid_base_kg" double precision,
	"completed_steps" integer DEFAULT 0 NOT NULL,
	"factor_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lifestyle_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link_path" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"product_name" text NOT NULL,
	"unit_paise" integer NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "order_items_qty_positive" CHECK ("order_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"user_id" bigint NOT NULL,
	"address_id" bigint,
	"subtotal_paise" integer NOT NULL,
	"discount_paise" integer DEFAULT 0 NOT NULL,
	"total_paise" integer NOT NULL,
	"coins_spent" integer DEFAULT 0 NOT NULL,
	"status" "order_status" DEFAULT 'placed' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number"),
	CONSTRAINT "orders_discount_within_cap" CHECK ("orders"."discount_paise" <= floor("orders"."subtotal_paise" * 0.20)),
	CONSTRAINT "orders_total_is_consistent" CHECK ("orders"."total_paise" = "orders"."subtotal_paise" - "orders"."discount_paise"),
	CONSTRAINT "orders_amounts_non_negative" CHECK ("orders"."subtotal_paise" >= 0 AND "orders"."discount_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" "product_category" NOT NULL,
	"price_paise" integer NOT NULL,
	"image_url" text,
	"stock" integer DEFAULT 0 NOT NULL,
	"co2_saved_kg" double precision,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "products_price_non_negative" CHECK ("products"."price_paise" >= 0),
	CONSTRAINT "products_stock_non_negative" CHECK ("products"."stock" >= 0)
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"grid_kg_per_kwh" double precision NOT NULL,
	"tariff_paise_per_kwh" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reward_transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"points_delta" integer DEFAULT 0 NOT NULL,
	"coins_delta" integer DEFAULT 0 NOT NULL,
	"source" "reward_source" NOT NULL,
	"source_id" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"family_id" text NOT NULL,
	"platform" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"phone" text,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"avatar_url" text,
	"city" text,
	"region_code" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"points_total" integer DEFAULT 0 NOT NULL,
	"coins_balance" integer DEFAULT 0 NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"longest_streak" integer DEFAULT 0 NOT NULL,
	"onboarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_points_non_negative" CHECK ("users"."points_total" >= 0),
	CONSTRAINT "users_coins_non_negative" CHECK ("users"."coins_balance" >= 0)
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cities" ADD CONSTRAINT "cities_region_code_regions_code_fk" FOREIGN KEY ("region_code") REFERENCES "public"."regions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_footprints" ADD CONSTRAINT "daily_footprints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_footprints" ADD CONSTRAINT "daily_footprints_daily_log_id_daily_logs_id_fk" FOREIGN KEY ("daily_log_id") REFERENCES "public"."daily_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_logs" ADD CONSTRAINT "daily_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_hosts" ADD CONSTRAINT "event_hosts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_hosts" ADD CONSTRAINT "event_hosts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_passes" ADD CONSTRAINT "event_passes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_passes" ADD CONSTRAINT "event_passes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_passes" ADD CONSTRAINT "event_passes_checked_in_by_users_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifestyle_profiles" ADD CONSTRAINT "lifestyle_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_address_id_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_transactions" ADD CONSTRAINT "reward_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addresses_user_idx" ON "addresses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_actor_time_idx" ON "audit_logs" USING btree ("actor_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cities_name_idx" ON "cities" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "footprint_user_date_unq" ON "daily_footprints" USING btree ("user_id","log_date");--> statement-breakpoint
CREATE INDEX "footprint_user_date_desc_idx" ON "daily_footprints" USING btree ("user_id","log_date" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "daily_log_user_date_unq" ON "daily_logs" USING btree ("user_id","log_date");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_log_client_unq" ON "daily_logs" USING btree ("user_id","client_log_id");--> statement-breakpoint
CREATE INDEX "event_hosts_user_idx" ON "event_hosts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_pass_user_unq" ON "event_passes" USING btree ("event_id","user_id");--> statement-breakpoint
CREATE INDEX "event_pass_event_status_idx" ON "event_passes" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "events_upcoming_idx" ON "events" USING btree ("status","start_at");--> statement-breakpoint
CREATE INDEX "events_geo_idx" ON "events" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_goal_per_user" ON "goals" USING btree ("user_id") WHERE "goals"."status" = 'active';--> statement-breakpoint
CREATE INDEX "notif_unread_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_idempotency_unq" ON "orders" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "orders_user_time_idx" ON "orders" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_idempotency_unq" ON "reward_transactions" USING btree ("user_id","source","source_id");--> statement-breakpoint
CREATE INDEX "reward_user_time_idx" ON "reward_transactions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_family_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "users_points_idx" ON "users" USING btree ("points_total" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_region_points_idx" ON "users" USING btree ("region_code","points_total" DESC NULLS LAST);