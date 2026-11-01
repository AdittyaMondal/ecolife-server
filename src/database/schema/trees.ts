import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { treeRarities } from './tree-rarities.ts';

/** One visual step in a tree's growth, when the client renders progression. */
export type GrowthStage = {
  stage: number;
  label: string;
  imageUrl: string;
};

/**
 * The tree catalogue (PRD-v2 §4.5).
 *
 * Catalogue rows are never deleted — `isActive` retires one instead, because a
 * user who already owns a tree must not have it vanish out of their forest.
 * `user_trees.tree_id` is therefore ON DELETE RESTRICT, and the database refuses
 * the delete even if someone reaches for it.
 */
export const trees = pgTable(
  'trees',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    rarityId: bigint('rarity_id', { mode: 'number' })
      .notNull()
      .references(() => treeRarities.id, { onDelete: 'restrict' }),
    imageUrl: text('image_url').notNull(),
    /**
     * Optional. Null means "one artwork, no progression" — which is every tree
     * until something advances a stage, and nothing does yet (`src/jobs/` is
     * empty). Shaped as `GrowthStage[]`.
     */
    growthStages: jsonb('growth_stages').$type<GrowthStage[]>(),
    /** Environmental impact, the reason a tree is a reward and not a sticker. */
    co2OffsetKgPerYear: doublePrecision('co2_offset_kg_per_year').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('trees_co2_non_negative', sql`${t.co2OffsetKgPerYear} >= 0`),
    // The roll pool is "active trees of an active rarity", so this pair is the
    // hot index on every grant, not only on the catalogue listing.
    index('trees_rarity_idx').on(t.rarityId, t.isActive),
  ],
);
