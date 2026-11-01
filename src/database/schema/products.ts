import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { discountType, productCategory } from './enums.ts';
import { organizations } from './organizations.ts';

/**
 * Marketplace catalogue (PRD-v2 §6.5, §7.6).
 *
 * Prices are integer PAISE. No float ever touches money. `co2SavedKg` is the
 * reason the product is in an eco marketplace at all, so it is a first-class
 * column and shown on the card.
 */
export const products = pgTable(
  'products',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    category: productCategory('category').notNull(),
    pricePaise: integer('price_paise').notNull(),
    imageUrl: text('image_url'),
    images: jsonb('images').$type<string[]>().notNull().default([]),
    stock: integer('stock').notNull().default(0),
    co2SavedKg: doublePrecision('co2_saved_kg'),
    /**
     * Pricing & discounts (Requirement 23)
     */
    discountType: discountType('discount_type').notNull().default('none'),
    discountValue: integer('discount_value').notNull().default(0),
    discountStartDate: timestamp('discount_start_date', { withTimezone: true }),
    discountEndDate: timestamp('discount_end_date', { withTimezone: true }),
    allowCoinRedemption: boolean('allow_coin_redemption').notNull().default(true),
    maxCoinRedemptionPercent: integer('max_coin_redemption_percent').notNull().default(20),
    /**
     * The seller that owns this row, once the Seller Portal exists. Nullable
     * because today's catalogue is admin-managed and unowned. Added now rather
     * than later: a column on a populated table is a migration, and this one is
     * free while every row is still NULL.
     */
    sellerOrgId: bigint('seller_org_id', { mode: 'number' }).references(() => organizations.id, {
      onDelete: 'restrict',
    }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('products_price_non_negative', sql`${t.pricePaise} >= 0`),
    check('products_stock_non_negative', sql`${t.stock} >= 0`),
    check('products_discount_value_non_negative', sql`${t.discountValue} >= 0`),
    check(
      'products_max_coins_pct_valid',
      sql`${t.maxCoinRedemptionPercent} >= 0 AND ${t.maxCoinRedemptionPercent} <= 100`,
    ),
    index('products_category_idx').on(t.category, t.isActive),
    index('products_seller_idx').on(t.sellerOrgId, t.isActive),
  ],
);
