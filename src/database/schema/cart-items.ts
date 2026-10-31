import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, primaryKey, timestamp } from 'drizzle-orm/pg-core';
import { products } from './products.ts';
import { users } from './users.ts';

/** PRD-v2 §7.6. One row per (user, product); quantity carries the count. */
export const cartItems = pgTable(
  'cart_items',
  {
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: bigint('product_id', { mode: 'number' })
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull().default(1),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.productId] }),
    check('cart_qty_positive', sql`${t.quantity} > 0`),
  ],
);
