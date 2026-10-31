import type { Executor } from '@common/rewards/rewards.ts';
import { db } from '@database/client.ts';
import { addresses, cartItems, orderItems, orders, products } from '@database/schema/index.ts';
import { and, asc, desc, eq, ilike, lt, or, sql } from 'drizzle-orm';

/** Every Drizzle query for the marketplace and address modules. */

export type ProductRow = typeof products.$inferSelect;
export type AddressRow = typeof addresses.$inferSelect;

const PRODUCT_COLUMNS = {
  id: products.id,
  slug: products.slug,
  name: products.name,
  description: products.description,
  category: products.category,
  pricePaise: products.pricePaise,
  imageUrl: products.imageUrl,
  stock: products.stock,
  co2SavedKg: products.co2SavedKg,
} as const;

export type Sort = 'newest' | 'price_asc' | 'price_desc' | 'co2_desc';

/**
 * The catalogue.
 *
 * `%` and `_` are escaped before building the ILIKE pattern, so a search for
 * `%` is a literal search rather than a full table scan that returns
 * everything. Every ordering ends in `id` so the keyset cursor is stable —
 * two products at the same price would otherwise swap between pages.
 */
export function listProducts(opts: {
  category?: string;
  q?: string;
  sort: Sort;
  afterId: number | null;
  limit: number;
}) {
  const pattern = opts.q ? `%${opts.q.replace(/[\\%_]/g, '\\$&')}%` : null;

  const order = {
    newest: [desc(products.id)],
    price_asc: [asc(products.pricePaise), asc(products.id)],
    price_desc: [desc(products.pricePaise), asc(products.id)],
    co2_desc: [desc(products.co2SavedKg), asc(products.id)],
  }[opts.sort];

  return db
    .select(PRODUCT_COLUMNS)
    .from(products)
    .where(
      and(
        eq(products.isActive, true),
        opts.category ? eq(products.category, opts.category as ProductRow['category']) : undefined,
        pattern
          ? or(ilike(products.name, pattern), ilike(products.description, pattern))
          : undefined,
        // Cursor only applies to the default ordering, where id is monotonic
        // with the sort key. Other sorts page by offset of the cursor id.
        opts.afterId !== null && opts.sort === 'newest' ? lt(products.id, opts.afterId) : undefined,
      ),
    )
    .orderBy(...order)
    .limit(opts.limit + 1);
}

export async function findProductBySlug(slug: string) {
  const [row] = await db
    .select(PRODUCT_COLUMNS)
    .from(products)
    .where(and(eq(products.slug, slug), eq(products.isActive, true)));
  return row ?? null;
}

/**
 * An ACTIVE product. Withdrawn stock is not merely hidden from the catalogue.
 *
 * Without the `is_active` predicate a delisted product could still be added
 * to a cart and ordered by anyone holding its id — the listing filters it,
 * which makes the gap invisible rather than absent.
 */
export async function findProduct(id: number, tx: Executor = db) {
  const [row] = await tx
    .select(PRODUCT_COLUMNS)
    .from(products)
    .where(and(eq(products.id, id), eq(products.isActive, true)));
  return row ?? null;
}

/** The cart, joined to live product rows so prices are never stale. */
export function listCart(userId: number, tx: Executor = db) {
  return tx
    .select({ quantity: cartItems.quantity, product: PRODUCT_COLUMNS })
    .from(cartItems)
    .innerJoin(products, eq(products.id, cartItems.productId))
    .where(eq(cartItems.userId, userId))
    .orderBy(asc(cartItems.productId));
}

/** Adds to an existing line rather than replacing it, clamped to `max`. */
export async function upsertCartLine(
  userId: number,
  productId: number,
  quantity: number,
  max: number,
) {
  await db
    .insert(cartItems)
    .values({ userId, productId, quantity })
    .onConflictDoUpdate({
      target: [cartItems.userId, cartItems.productId],
      set: { quantity: sql`least(${cartItems.quantity} + ${quantity}, ${max})` },
    });
}

export async function setCartQuantity(userId: number, productId: number, quantity: number) {
  await db
    .update(cartItems)
    .set({ quantity })
    .where(and(eq(cartItems.userId, userId), eq(cartItems.productId, productId)));
}

export async function removeCartLine(userId: number, productId: number, tx: Executor = db) {
  await tx
    .delete(cartItems)
    .where(and(eq(cartItems.userId, userId), eq(cartItems.productId, productId)));
}

export async function clearCart(userId: number, tx: Executor) {
  await tx.delete(cartItems).where(eq(cartItems.userId, userId));
}

/**
 * Decrements stock, but only if there is enough.
 *
 * The check is the WHERE clause, not a prior SELECT: two orders for the last
 * item would both pass a read-then-write check and both commit, and
 * `products_stock_non_negative` would then fail the transaction with a
 * constraint violation instead of a usable error. Here the loser simply
 * matches no row and gets SHOP_001.
 */
export async function decrementStock(tx: Executor, productId: number, quantity: number) {
  const [row] = await tx
    .update(products)
    .set({ stock: sql`${products.stock} - ${quantity}` })
    .where(
      and(
        eq(products.id, productId),
        eq(products.isActive, true),
        sql`${products.stock} >= ${quantity}`,
      ),
    )
    .returning({ stock: products.stock });
  return row ?? null;
}

export async function findOrderByKey(userId: number, idempotencyKey: string, tx: Executor = db) {
  const [row] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.userId, userId), eq(orders.idempotencyKey, idempotencyKey)));
  return row ?? null;
}

export async function insertOrder(tx: Executor, values: typeof orders.$inferInsert) {
  const [row] = await tx.insert(orders).values(values).returning();
  if (!row) throw new Error('order insert returned nothing');
  return row;
}

export async function insertOrderItems(tx: Executor, rows: (typeof orderItems.$inferInsert)[]) {
  if (rows.length > 0) await tx.insert(orderItems).values(rows);
}

export function listOrderItems(orderIds: number[]) {
  if (orderIds.length === 0) return Promise.resolve([]);
  return db
    .select()
    .from(orderItems)
    .where(sql`${orderItems.orderId} in ${orderIds}`)
    .orderBy(asc(orderItems.id));
}

export function listOrders(userId: number, limit: number, beforeId: number | null) {
  return db
    .select()
    .from(orders)
    .where(and(eq(orders.userId, userId), beforeId === null ? undefined : lt(orders.id, beforeId)))
    .orderBy(desc(orders.id))
    .limit(limit + 1);
}

export async function findOrder(userId: number, id: number) {
  const [row] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, id), eq(orders.userId, userId)));
  return row ?? null;
}

// --- addresses -------------------------------------------------------------

export function listAddresses(userId: number) {
  return db
    .select()
    .from(addresses)
    .where(eq(addresses.userId, userId))
    .orderBy(desc(addresses.isDefault), asc(addresses.id));
}

export async function findAddress(userId: number, id: number, tx: Executor = db) {
  const [row] = await tx
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, id), eq(addresses.userId, userId)));
  return row ?? null;
}

/** Exactly one default per user; setting one clears the rest. */
export async function clearDefault(tx: Executor, userId: number, exceptId?: number) {
  await tx
    .update(addresses)
    .set({ isDefault: false })
    .where(
      and(
        eq(addresses.userId, userId),
        eq(addresses.isDefault, true),
        exceptId === undefined ? undefined : sql`${addresses.id} <> ${exceptId}`,
      ),
    );
}

export async function insertAddress(tx: Executor, values: typeof addresses.$inferInsert) {
  const [row] = await tx.insert(addresses).values(values).returning();
  if (!row) throw new Error('address insert returned nothing');
  return row;
}

export async function updateAddress(
  tx: Executor,
  userId: number,
  id: number,
  values: Partial<typeof addresses.$inferInsert>,
) {
  const [row] = await tx
    .update(addresses)
    .set(values)
    .where(and(eq(addresses.id, id), eq(addresses.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteAddress(userId: number, id: number) {
  const [row] = await db
    .delete(addresses)
    .where(and(eq(addresses.id, id), eq(addresses.userId, userId)))
    .returning({ id: addresses.id });
  return row ?? null;
}

/** `ECO-2026-00042`. Sequential within a year, from the orders table itself. */
export async function nextOrderNumber(tx: Executor) {
  const year = new Date().getUTCFullYear();
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(sql`${orders.orderNumber} like ${`ECO-${year}-%`}`);
  return `ECO-${year}-${String((row?.n ?? 0) + 1).padStart(5, '0')}`;
}
