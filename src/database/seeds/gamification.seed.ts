import { treeRarities, trees } from '@database/schema/index.ts';
import { sql } from 'drizzle-orm';
import { insertAll, type Tx } from './support.ts';

/**
 * The gamification catalogue (PRD-v2 §4.5).
 *
 * Upserts by slug rather than delete-and-reinsert, for the same reason
 * `seedProducts` does: `user_trees.tree_id` references these rows with
 * onDelete 'restrict', because a forest a user already owns must not lose
 * what is in it.
 */

/**
 * Five tiers covering the whole range, weights relative rather than
 * percentages: 600 + 250 + 100 + 40 + 10 = 1000, so a weight reads directly as
 * a per-mille chance while every tier is active.
 */
const RARITIES: { slug: string; name: string; rank: number; dropWeight: number }[] = [
  { slug: 'common', name: 'Common', rank: 1, dropWeight: 600 },
  { slug: 'uncommon', name: 'Uncommon', rank: 2, dropWeight: 250 },
  { slug: 'rare', name: 'Rare', rank: 3, dropWeight: 100 },
  { slug: 'epic', name: 'Epic', rank: 4, dropWeight: 40 },
  { slug: 'legendary', name: 'Legendary', rank: 5, dropWeight: 10 },
];

/**
 * Artwork.
 *
 * These are the verified-200 nature photographs this repo already uses
 * elsewhere, cycled deterministically — NOT species photographs. Nobody has
 * shot a Banyan for this catalogue yet, and §4.1.0 is explicit that an
 * invented URL ships as a broken image in both clients, so a real photo of the
 * wrong tree is the honest placeholder and a fake URL is not. Replace per-slug
 * when the asset pipeline exists.
 */
const ARTWORK = [
  'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?auto=format&fit=crop&w=800&q=80',
  'https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?auto=format&fit=crop&w=800&q=80',
  'https://images.unsplash.com/photo-1466692476868-aef1dfb1e735?auto=format&fit=crop&w=800&q=80',
  'https://images.unsplash.com/photo-1512428813834-c702c7702b78?auto=format&fit=crop&w=800&q=80',
  'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80',
  'https://images.unsplash.com/photo-1550751827-4bd374c3f58b?auto=format&fit=crop&w=800&q=80',
] as const;

/**
 * `[slug, name, binomial, raritySlug, co2OffsetKgPerYear]`.
 *
 * Rarity tracks real-world SCARCITY, not size — which is why Sandalwood and
 * Red Sanders are Legendary while offsetting less than a Banyan. Both are
 * endangered and protected in India; that is the thing worth making rare.
 */
const CATALOGUE: [string, string, string, string, number][] = [
  // Common — fast, hardy, planted everywhere.
  ['neem', 'Neem', 'Azadirachta indica', 'common', 48],
  ['drumstick', 'Drumstick', 'Moringa oleifera', 'common', 20],
  ['guava', 'Guava', 'Psidium guajava', 'common', 18],
  ['curry-leaf', 'Curry Leaf', 'Murraya koenigii', 'common', 12],
  ['hibiscus', 'Hibiscus', 'Hibiscus rosa-sinensis', 'common', 8],
  ['papaya', 'Papaya', 'Carica papaya', 'common', 15],
  // Uncommon — the orchard and avenue trees.
  ['mango', 'Mango', 'Mangifera indica', 'uncommon', 62],
  ['jamun', 'Jamun', 'Syzygium cumini', 'uncommon', 55],
  ['tamarind', 'Tamarind', 'Tamarindus indica', 'uncommon', 70],
  ['amla', 'Indian Gooseberry', 'Phyllanthus emblica', 'uncommon', 30],
  ['gulmohar', 'Gulmohar', 'Delonix regia', 'uncommon', 45],
  // Rare — long-lived, slow, culturally protected.
  ['peepal', 'Peepal', 'Ficus religiosa', 'rare', 110],
  ['arjuna', 'Arjuna', 'Terminalia arjuna', 'rare', 95],
  ['bael', 'Bael', 'Aegle marmelos', 'rare', 40],
  ['kadamba', 'Kadamba', 'Neolamarckia cadamba', 'rare', 85],
  // Epic — the canopy giants and prized timber.
  ['banyan', 'Banyan', 'Ficus benghalensis', 'epic', 240],
  ['indian-rosewood', 'Indian Rosewood', 'Dalbergia sissoo', 'epic', 150],
  ['palash', 'Flame of the Forest', 'Butea monosperma', 'epic', 75],
  // Legendary — endangered and protected. Scarcity, not stature.
  ['sandalwood', 'Indian Sandalwood', 'Santalum album', 'legendary', 55],
  ['red-sanders', 'Red Sanders', 'Pterocarpus santalinus', 'legendary', 90],
];

/**
 * Growth stages are OPTIONAL and most trees have none. Two carry them so the
 * jsonb column has real data in it on a fresh seed; nothing advances a stage
 * yet, because `src/jobs/` has no scheduler.
 */
const GROWTH_STAGES: Record<string, { stage: number; label: string; imageUrl: string }[]> = {
  neem: [
    { stage: 1, label: 'Seedling', imageUrl: ARTWORK[1] },
    { stage: 2, label: 'Sapling', imageUrl: ARTWORK[2] },
    { stage: 3, label: 'Mature', imageUrl: ARTWORK[0] },
  ],
  banyan: [
    { stage: 1, label: 'Seedling', imageUrl: ARTWORK[1] },
    { stage: 2, label: 'Young', imageUrl: ARTWORK[3] },
    { stage: 3, label: 'Spreading', imageUrl: ARTWORK[4] },
    { stage: 4, label: 'Ancient', imageUrl: ARTWORK[5] },
  ],
};

export type SeededCatalogue = {
  rarities: Map<string, number>;
  trees: Map<string, number>;
};

/** Upserts the rarity tiers and the tree catalogue. Returns slug → id maps. */
export async function seedGamification(tx: Tx): Promise<SeededCatalogue> {
  const rarityRows = await tx
    .insert(treeRarities)
    .values(RARITIES)
    .onConflictDoUpdate({
      target: treeRarities.slug,
      set: {
        name: sql`excluded.name`,
        rank: sql`excluded.rank`,
        dropWeight: sql`excluded.drop_weight`,
        isActive: sql`excluded.is_active`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: treeRarities.id, slug: treeRarities.slug });

  const rarities = new Map(rarityRows.map((r) => [r.slug, r.id]));

  const rows = CATALOGUE.map(([slug, name, binomial, raritySlug, co2], i) => {
    const rarityId = rarities.get(raritySlug);
    // A typo in a rarity slug would otherwise insert a NULL FK and fail with a
    // constraint name that says nothing about which catalogue row is wrong.
    if (rarityId === undefined) {
      throw new Error(`tree '${slug}' names unknown rarity '${raritySlug}'`);
    }
    return {
      slug,
      name,
      description: `${binomial}. Native to India.`,
      rarityId,
      imageUrl: ARTWORK[i % ARTWORK.length] as string,
      growthStages: GROWTH_STAGES[slug] ?? null,
      co2OffsetKgPerYear: co2,
      isActive: true,
    };
  });

  const treeRows: { id: number; slug: string }[] = [];
  await insertAll(rows, async (batch) => {
    const inserted = await tx
      .insert(trees)
      .values(batch)
      .onConflictDoUpdate({
        target: trees.slug,
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          rarityId: sql`excluded.rarity_id`,
          imageUrl: sql`excluded.image_url`,
          growthStages: sql`excluded.growth_stages`,
          co2OffsetKgPerYear: sql`excluded.co2_offset_kg_per_year`,
          isActive: sql`excluded.is_active`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: trees.id, slug: trees.slug });
    treeRows.push(...inserted);
  });

  return { rarities, trees: new Map(treeRows.map((r) => [r.slug, r.id])) };
}
