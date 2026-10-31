import { products } from '@database/schema/index.ts';
import { sql } from 'drizzle-orm';
import { insertAll, type Tx } from './support.ts';

type Row = typeof products.$inferInsert;

/**
 * Marketplace catalogue (PRD-v2 §6.5), 24 products across all five categories.
 *
 * Prices are integer paise — no float ever touches money. `co2SavedKg` is the
 * reason a product is in an eco marketplace at all, so every row has one: a
 * null would render as a blank claim on the card.
 *
 * Two rows exist to make UI states real rather than to sell anything:
 * `bamboo-cutlery-travel-set` is out of stock, and `jute-laptop-sleeve` is
 * inactive. The checkout and the listing both have to handle them.
 */
const CATALOGUE: ReadonlyArray<
  [slug: string, name: string, category: Row['category'], paise: number, stock: number, co2: number]
> = [
  // --- plants ---
  ['tulsi-sapling', 'Tulsi Sapling', 'plants', 14_900, 120, 8.5],
  ['neem-sapling', 'Neem Sapling', 'plants', 19_900, 80, 21.4],
  ['money-plant-jar', 'Money Plant in a Recycled Jar', 'plants', 24_900, 64, 6.2],
  ['snake-plant-pot', 'Snake Plant in a Terracotta Pot', 'plants', 34_900, 45, 7.8],
  ['curry-leaf-plant', 'Curry Leaf Plant', 'plants', 22_900, 52, 9.1],
  ['balcony-herb-trio', 'Balcony Herb Trio: Mint, Basil, Coriander', 'plants', 44_900, 30, 12.6],
  // --- household ---
  ['compost-bin-10l', 'Terracotta Compost Bin, 10 L', 'household', 129_900, 24, 64.0],
  ['led-bulb-pack-4', 'LED Bulb Pack of 4, 9 W', 'household', 49_900, 150, 48.3],
  ['solar-lantern', 'Solar Study Lantern', 'household', 89_900, 38, 37.5],
  ['jute-laundry-basket', 'Jute Laundry Basket', 'household', 64_900, 40, 4.4],
  ['cloth-shopping-bags-5', 'Cotton Shopping Bags, Set of 5', 'household', 34_900, 200, 11.2],
  // --- personal_care ---
  ['bamboo-toothbrush-4', 'Bamboo Toothbrush, Pack of 4', 'personal_care', 29_900, 180, 2.1],
  ['shampoo-bar', 'Solid Shampoo Bar', 'personal_care', 34_900, 95, 3.6],
  ['neem-wood-comb', 'Neem Wood Comb', 'personal_care', 19_900, 110, 0.9],
  ['menstrual-cup', 'Medical-Grade Silicone Menstrual Cup', 'personal_care', 59_900, 70, 112.0],
  ['bamboo-razor', 'Bamboo Safety Razor', 'personal_care', 79_900, 44, 5.8],
  // --- kitchen ---
  ['copper-water-bottle', 'Copper Water Bottle, 1 L', 'kitchen', 99_900, 60, 23.7],
  ['steel-tiffin-3-tier', 'Stainless Steel Tiffin, 3 Tier', 'kitchen', 84_900, 75, 18.9],
  ['beeswax-food-wraps-3', 'Beeswax Food Wraps, Set of 3', 'kitchen', 54_900, 88, 6.7],
  ['bamboo-cutlery-travel-set', 'Bamboo Cutlery Travel Set', 'kitchen', 39_900, 0, 3.2],
  ['clay-cookware-handi', 'Unglazed Clay Handi', 'kitchen', 74_900, 26, 9.4],
  // --- stationery ---
  ['recycled-notebook-a5', 'Recycled Paper Notebook, A5', 'stationery', 17_900, 220, 1.8],
  ['seed-pencils-10', 'Plantable Seed Pencils, Pack of 10', 'stationery', 24_900, 130, 2.4],
  ['jute-laptop-sleeve', 'Jute Laptop Sleeve, 14"', 'stationery', 69_900, 18, 5.1],
];

/** Which slugs are deliberately not buyable. */
const INACTIVE = new Set(['jute-laptop-sleeve']);

/**
 * Upserts by slug.
 *
 * Products are never deleted and reinserted: `order_items.product_id`
 * references them with onDelete 'restrict', because an order is a financial
 * record that must not lose what was in it.
 */
export async function seedProducts(tx: Tx): Promise<number> {
  const rows: Row[] = CATALOGUE.map(([slug, name, category, pricePaise, stock, co2SavedKg]) => ({
    slug,
    name,
    description: `${name}. Replaces a single-use or high-carbon alternative.`,
    category,
    pricePaise,
    imageUrl: `https://cdn.ecolife.app/products/${slug}.webp`,
    stock,
    co2SavedKg,
    isActive: !INACTIVE.has(slug),
  }));

  await insertAll(rows, (batch) =>
    tx
      .insert(products)
      .values(batch)
      .onConflictDoUpdate({
        target: products.slug,
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          category: sql`excluded.category`,
          pricePaise: sql`excluded.price_paise`,
          imageUrl: sql`excluded.image_url`,
          stock: sql`excluded.stock`,
          co2SavedKg: sql`excluded.co2_saved_kg`,
          isActive: sql`excluded.is_active`,
        },
      }),
  );

  return rows.length;
}
