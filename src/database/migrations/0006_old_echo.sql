CREATE TABLE "tree_rarities" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"rank" integer NOT NULL,
	"drop_weight" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tree_rarities_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tree_rarity_rank_positive" CHECK ("tree_rarities"."rank" > 0),
	CONSTRAINT "tree_rarity_weight_positive" CHECK ("tree_rarities"."drop_weight" > 0)
);
--> statement-breakpoint
CREATE TABLE "trees" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"rarity_id" bigint NOT NULL,
	"image_url" text NOT NULL,
	"growth_stages" jsonb,
	"co2_offset_kg_per_year" double precision DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trees_slug_unique" UNIQUE("slug"),
	CONSTRAINT "trees_co2_non_negative" CHECK ("trees"."co2_offset_kg_per_year" >= 0)
);
--> statement-breakpoint
ALTER TABLE "trees" ADD CONSTRAINT "trees_rarity_id_tree_rarities_id_fk" FOREIGN KEY ("rarity_id") REFERENCES "public"."tree_rarities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tree_rarity_rank_unq" ON "tree_rarities" USING btree ("rank");--> statement-breakpoint
CREATE INDEX "trees_rarity_idx" ON "trees" USING btree ("rarity_id","is_active");