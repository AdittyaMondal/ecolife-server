import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Rarity tiers for the tree catalogue (PRD-v2 §4.5).
 *
 * A TABLE rather than a pgEnum, because adding a sixth tier or re-balancing a
 * drop rate must be an admin edit, not a migration plus a deploy. An enum would
 * also put the drop weight somewhere else, and a weight that lives apart from
 * the tier it belongs to is a weight that goes stale.
 *
 * `rank` ascends with rarity: 1 is the most common tier, N the rarest. The pity
 * mechanic reads it as "rank >= pityMinRank is a good drop", so the direction is
 * load-bearing — reversing it silently inverts every pity rule.
 */
export const treeRarities = pgTable(
  'tree_rarities',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    rank: integer('rank').notNull(),
    /**
     * Relative likelihood, not a percentage. A weighted roll divides by the sum
     * of the active tiers' weights, so weights stay meaningful when a tier is
     * disabled and nobody has to keep a column of percentages adding to 100.
     */
    dropWeight: integer('drop_weight').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One tier per rank, so "rarer than" is always a total order.
    uniqueIndex('tree_rarity_rank_unq').on(t.rank),
    check('tree_rarity_rank_positive', sql`${t.rank} > 0`),
    // A zero weight would sit in the pool contributing nothing and read as a
    // bug at roll time; a negative one breaks the cumulative scan outright.
    check('tree_rarity_weight_positive', sql`${t.dropWeight} > 0`),
  ],
);
