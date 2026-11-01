import type { Executor } from '@common/rewards/rewards.ts';
import { db } from '@database/client.ts';
import { treeRarities, trees } from '@database/schema/index.ts';
import { and, asc, desc, eq, lt } from 'drizzle-orm';

/**
 * Every Drizzle query for the gamification READ and ADMIN surface.
 *
 * The grant path is deliberately elsewhere — `@common/gamification/grant.ts`
 * owns the writes to `user_trees`, `tree_rolls` and `user_badges`, because it is
 * called from `award()` in `@common/rewards`, and nothing under `src/common/`
 * imports from `@modules/*`. Same split as `common/rewards` writing
 * `reward_transactions` while `profile.repository` reads it.
 */

export type RarityRow = typeof treeRarities.$inferSelect;
export type TreeRow = typeof trees.$inferSelect;

const RARITY_COLUMNS = {
  id: treeRarities.id,
  slug: treeRarities.slug,
  name: treeRarities.name,
  rank: treeRarities.rank,
  dropWeight: treeRarities.dropWeight,
  isActive: treeRarities.isActive,
} as const;

const TREE_COLUMNS = {
  id: trees.id,
  slug: trees.slug,
  name: trees.name,
  description: trees.description,
  imageUrl: trees.imageUrl,
  growthStages: trees.growthStages,
  co2OffsetKgPerYear: trees.co2OffsetKgPerYear,
  isActive: trees.isActive,
} as const;

/** Rarity tiers, rarest last. `includeInactive` is the admin view. */
export function listRarities(includeInactive = false, tx: Executor = db) {
  return tx
    .select(RARITY_COLUMNS)
    .from(treeRarities)
    .where(includeInactive ? undefined : eq(treeRarities.isActive, true))
    .orderBy(asc(treeRarities.rank));
}

export async function findRarityBySlug(slug: string, tx: Executor = db) {
  const [row] = await tx
    .select(RARITY_COLUMNS)
    .from(treeRarities)
    .where(eq(treeRarities.slug, slug));
  return row ?? null;
}

/**
 * The catalogue, newest first so the keyset cursor on `id` is monotonic with
 * the sort key — the same reason `listProducts` orders every variant by id.
 */
export function listTrees(
  opts: { rarityId?: number; includeInactive?: boolean; afterId: number | null; limit: number },
  tx: Executor = db,
) {
  return tx
    .select({ tree: TREE_COLUMNS, rarity: RARITY_COLUMNS })
    .from(trees)
    .innerJoin(treeRarities, eq(trees.rarityId, treeRarities.id))
    .where(
      and(
        opts.includeInactive ? undefined : eq(trees.isActive, true),
        opts.rarityId !== undefined ? eq(trees.rarityId, opts.rarityId) : undefined,
        opts.afterId !== null ? lt(trees.id, opts.afterId) : undefined,
      ),
    )
    .orderBy(desc(trees.id))
    .limit(opts.limit + 1);
}

export async function findTreeBySlug(slug: string, includeInactive = false, tx: Executor = db) {
  const [row] = await tx
    .select({ tree: TREE_COLUMNS, rarity: RARITY_COLUMNS })
    .from(trees)
    .innerJoin(treeRarities, eq(trees.rarityId, treeRarities.id))
    .where(and(eq(trees.slug, slug), includeInactive ? undefined : eq(trees.isActive, true)));
  return row ?? null;
}

export async function findTreeById(id: number, includeInactive = false, tx: Executor = db) {
  const [row] = await tx
    .select({ tree: TREE_COLUMNS, rarity: RARITY_COLUMNS })
    .from(trees)
    .innerJoin(treeRarities, eq(trees.rarityId, treeRarities.id))
    .where(and(eq(trees.id, id), includeInactive ? undefined : eq(trees.isActive, true)));
  return row ?? null;
}
