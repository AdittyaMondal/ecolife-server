import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { productCategory } from './enums.ts';

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
    stock: integer('stock').notNull().default(0),
    co2SavedKg: doublePrecision('co2_saved_kg'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('products_price_non_negative', sql`${t.pricePaise} >= 0`),
    // A conditional stock decrement can never drive this below zero, and if a
    // bug tries, the write fails rather than overselling.
    check('products_stock_non_negative', sql`${t.stock} >= 0`),
    index('products_category_idx').on(t.category, t.isActive),
  ],
);
