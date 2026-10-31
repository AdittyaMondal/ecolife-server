import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { addresses } from './addresses.ts';
import { orderStatus } from './enums.ts';
import { products } from './products.ts';
import { users } from './users.ts';

/**
 * PRD-v2 §6.5, §7.6. All money is integer paise.
 *
 * `orders_discount_within_cap` puts the 20% coin-discount ceiling in the
 * DATABASE, not only in the pricing function. If a bug in that function ever
 * computes an 80%-off order, the INSERT fails instead of shipping. The
 * application check is the UX; this is the guarantee.
 *
 * `onDelete: 'restrict'` on both references: an order is a financial record
 * and must not vanish because a user or product row was removed.
 */
export const orders = pgTable(
  'orders',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orderNumber: text('order_number').notNull().unique(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    addressId: bigint('address_id', { mode: 'number' }).references(() => addresses.id, {
      onDelete: 'set null',
    }),
    subtotalPaise: integer('subtotal_paise').notNull(),
    discountPaise: integer('discount_paise').notNull().default(0),
    totalPaise: integer('total_paise').notNull(),
    coinsSpent: integer('coins_spent').notNull().default(0),
    status: orderStatus('status').notNull().default('placed'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Replaying a checkout returns the original order instead of charging twice.
    uniqueIndex('order_idempotency_unq').on(t.userId, t.idempotencyKey),
    check(
      'orders_discount_within_cap',
      sql`${t.discountPaise} <= floor(${t.subtotalPaise} * 0.20)`,
    ),
    check(
      'orders_total_is_consistent',
      sql`${t.totalPaise} = ${t.subtotalPaise} - ${t.discountPaise}`,
    ),
    check('orders_amounts_non_negative', sql`${t.subtotalPaise} >= 0 AND ${t.discountPaise} >= 0`),
    index('orders_user_time_idx').on(t.userId, t.createdAt.desc()),
  ],
);

/**
 * Price and name are SNAPSHOTS. Renaming or repricing a product must not
 * rewrite what someone already bought.
 */
export const orderItems = pgTable(
  'order_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orderId: bigint('order_id', { mode: 'number' })
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: bigint('product_id', { mode: 'number' })
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    productName: text('product_name').notNull(),
    unitPaise: integer('unit_paise').notNull(),
    quantity: integer('quantity').notNull(),
  },
  (t) => [
    index('order_items_order_idx').on(t.orderId),
    check('order_items_qty_positive', sql`${t.quantity} > 0`),
  ],
);
