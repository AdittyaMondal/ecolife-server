import type { Executor } from '@common/rewards/rewards.ts';
import { db } from '@database/client.ts';
import {
  addresses,
  cartItems,
  orderItems,
  orders,
  organizations,
  products,
  users,
} from '@database/schema/index.ts';
import { and, asc, desc, eq, gte, ilike, inArray, lt, lte, or, sql } from 'drizzle-orm';

/** Every Drizzle query for the marketplace and address modules. */

export type ProductRow = typeof products.$inferSelect;
export type AddressRow = typeof addresses.$inferSelect;

export const PRODUCT_COLUMNS = {
  id: products.id,
  slug: products.slug,
  name: products.name,
  description: products.description,
  category: products.category,
  pricePaise: products.pricePaise,
  imageUrl: products.imageUrl,
  images: products.images,
  stock: products.stock,
  co2SavedKg: products.co2SavedKg,
  discountType: products.discountType,
  discountValue: products.discountValue,
  discountStartDate: products.discountStartDate,
  discountEndDate: products.discountEndDate,
  allowCoinRedemption: products.allowCoinRedemption,
  maxCoinRedemptionPercent: products.maxCoinRedemptionPercent,
  sellerOrgId: products.sellerOrgId,
  isActive: products.isActive,
  createdAt: products.createdAt,
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

/**
 * The addresses behind a page of orders, in one query.
 *
 * The orders list used to serialise `address: null` for every row because
 * fetching one per order looked like an N+1 — so the client had to refetch
 * each order by id just to render a delivery line. One `in (...)` is neither
 * N+1 nor a lie.
 */
export async function findAddressesByIds(userId: number, ids: number[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(addresses)
    .where(and(eq(addresses.userId, userId), inArray(addresses.id, ids)));
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

// --- Seller Portal Repository Methods (Part 6) ------------------------------

export async function listSellerProducts(opts: {
  sellerOrgId: number;
  category?: string;
  status: 'all' | 'active' | 'inactive';
  q?: string;
  afterId: number | null;
  limit: number;
}) {
  const pattern = opts.q ? `%${opts.q.replace(/[\\%_]/g, '\\$&')}%` : null;

  return db
    .select(PRODUCT_COLUMNS)
    .from(products)
    .where(
      and(
        eq(products.sellerOrgId, opts.sellerOrgId),
        opts.status === 'active'
          ? eq(products.isActive, true)
          : opts.status === 'inactive'
            ? eq(products.isActive, false)
            : undefined,
        opts.category ? eq(products.category, opts.category as ProductRow['category']) : undefined,
        pattern
          ? or(ilike(products.name, pattern), ilike(products.description, pattern))
          : undefined,
        opts.afterId !== null ? lt(products.id, opts.afterId) : undefined,
      ),
    )
    .orderBy(desc(products.id))
    .limit(opts.limit + 1);
}

export async function insertProduct(values: typeof products.$inferInsert, tx: Executor = db) {
  const [row] = await tx.insert(products).values(values).returning();
  if (!row) throw new Error('Product insert returned nothing');
  return row;
}

export async function findSellerProduct(sellerOrgId: number, id: number, tx: Executor = db) {
  const [row] = await tx
    .select(PRODUCT_COLUMNS)
    .from(products)
    .where(and(eq(products.id, id), eq(products.sellerOrgId, sellerOrgId)));
  return row ?? null;
}

export async function updateSellerProduct(
  sellerOrgId: number,
  id: number,
  values: Partial<typeof products.$inferInsert>,
  tx: Executor = db,
) {
  const [row] = await tx
    .update(products)
    .set(values)
    .where(and(eq(products.id, id), eq(products.sellerOrgId, sellerOrgId)))
    .returning();
  return row ?? null;
}

export async function deleteSellerProduct(sellerOrgId: number, id: number, tx: Executor = db) {
  // Check if product was ever ordered
  const [ordered] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(orderItems)
    .where(eq(orderItems.productId, id));

  if ((ordered?.count ?? 0) > 0) {
    // Soft-deactivate to maintain financial integrity
    const [row] = await tx
      .update(products)
      .set({ isActive: false })
      .where(and(eq(products.id, id), eq(products.sellerOrgId, sellerOrgId)))
      .returning();
    return row ?? null;
  }

  const [deleted] = await tx
    .delete(products)
    .where(and(eq(products.id, id), eq(products.sellerOrgId, sellerOrgId)))
    .returning();
  return deleted ?? null;
}

export async function listSellerOrders(opts: {
  sellerOrgId: number;
  status?: string;
  onlyRedemptions?: boolean;
  afterId: number | null;
  limit: number;
}) {
  // Find distinct order IDs containing items from this seller
  const matchingOrderIdsQuery = db
    .selectDistinct({ orderId: orderItems.orderId })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orderItems.sellerOrgId, opts.sellerOrgId),
        opts.status
          ? eq(
              orderItems.status,
              opts.status as 'placed' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled',
            )
          : undefined,
        opts.onlyRedemptions ? sql`${orders.coinsSpent} > 0` : undefined,
        opts.afterId !== null ? lt(orders.id, opts.afterId) : undefined,
      ),
    )
    .orderBy(desc(orderItems.orderId))
    .limit(opts.limit + 1);

  const matched = await matchingOrderIdsQuery;
  const orderIds = matched.map((m) => m.orderId);
  if (orderIds.length === 0) return [];

  const [orderRows, itemRows, addressRows] = await Promise.all([
    db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        subtotalPaise: orders.subtotalPaise,
        discountPaise: orders.discountPaise,
        totalPaise: orders.totalPaise,
        coinsSpent: orders.coinsSpent,
        addressId: orders.addressId,
        createdAt: orders.createdAt,
        userId: orders.userId,
        userName: users.name,
        userEmail: users.email,
      })
      .from(orders)
      .innerJoin(users, eq(users.id, orders.userId))
      .where(inArray(orders.id, orderIds))
      .orderBy(desc(orders.id)),
    db
      .select({
        id: orderItems.id,
        orderId: orderItems.orderId,
        productId: orderItems.productId,
        productName: orderItems.productName,
        unitPaise: orderItems.unitPaise,
        quantity: orderItems.quantity,
        status: orderItems.status,
        sellerOrgId: orderItems.sellerOrgId,
      })
      .from(orderItems)
      .where(
        and(inArray(orderItems.orderId, orderIds), eq(orderItems.sellerOrgId, opts.sellerOrgId)),
      )
      .orderBy(asc(orderItems.id)),
    db
      .select()
      .from(addresses)
      .where(
        inArray(
          addresses.id,
          matched.map((_) => 0), // fallback handled below
        ),
      ),
  ]);

  const uniqueAddressIds = Array.from(
    new Set(orderRows.map((o) => o.addressId).filter((id): id is number => id !== null)),
  );
  const actualAddresses =
    uniqueAddressIds.length > 0
      ? await db.select().from(addresses).where(inArray(addresses.id, uniqueAddressIds))
      : [];
  const addressMap = new Map(actualAddresses.map((a) => [a.id, a]));

  const itemsByOrder = new Map<number, typeof itemRows>();
  for (const item of itemRows) {
    const list = itemsByOrder.get(item.orderId) ?? [];
    list.push(item);
    itemsByOrder.set(item.orderId, list);
  }

  return orderRows.map((ord) => {
    const items = itemsByOrder.get(ord.id) ?? [];
    const sellerSubtotalPaise = items.reduce((sum, it) => sum + it.unitPaise * it.quantity, 0);

    // Apportion coins spent and discount proportional to seller items in order
    const sellerRatio = ord.subtotalPaise > 0 ? sellerSubtotalPaise / ord.subtotalPaise : 1;
    const sellerCoinsSpent = Math.round(ord.coinsSpent * sellerRatio);
    const sellerDiscountPaise = Math.round(ord.discountPaise * sellerRatio);
    const sellerTotalPaise = sellerSubtotalPaise - sellerDiscountPaise;

    return {
      id: ord.id,
      orderNumber: ord.orderNumber,
      createdAt: ord.createdAt.toISOString(),
      status: ord.status,
      customer: {
        id: ord.userId,
        name: ord.userName,
        email: ord.userEmail,
      },
      address: ord.addressId ? (addressMap.get(ord.addressId) ?? null) : null,
      items: items.map((i) => ({
        id: i.id,
        productId: i.productId,
        productName: i.productName,
        unitPaise: i.unitPaise,
        quantity: i.quantity,
        totalPaise: i.unitPaise * i.quantity,
        status: i.status,
      })),
      sellerSubtotalPaise,
      sellerCoinsSpent,
      sellerDiscountPaise,
      sellerTotalPaise,
    };
  });
}

export type OrderItemStatus = 'placed' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';

/**
 * Every item on an order, whoever sells it.
 *
 * The order-level status is DERIVED from all of them, so the derivation needs
 * to see the lines this seller does not own. Row-locked, so two sellers moving
 * their own lines at the same moment cannot both compute the order status from
 * a stale read and have the loser's answer win.
 */
export async function lockOrderItems(orderId: number, tx: Executor) {
  return tx
    .select({
      id: orderItems.id,
      productId: orderItems.productId,
      quantity: orderItems.quantity,
      sellerOrgId: orderItems.sellerOrgId,
      status: orderItems.status,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .for('update');
}

/** Only this seller's lines. Scoped in the WHERE, so a foreign order matches nothing. */
export async function setSellerItemsStatus(
  sellerOrgId: number,
  orderId: number,
  status: OrderItemStatus,
  tx: Executor,
) {
  return tx
    .update(orderItems)
    .set({ status })
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.sellerOrgId, sellerOrgId)))
    .returning();
}

export async function setOrderStatus(orderId: number, status: OrderItemStatus, tx: Executor) {
  await tx.update(orders).set({ status }).where(eq(orders.id, orderId));
}

/** Puts stock back. The mirror of `decrementStock`, for a cancelled line. */
export async function restoreStock(productId: number, quantity: number, tx: Executor) {
  await tx
    .update(products)
    .set({ stock: sql`${products.stock} + ${quantity}` })
    .where(eq(products.id, productId));
}

export async function getSellerAnalytics(sellerOrgId: number) {
  // Get all order items for this seller
  const items = await db
    .select({
      productId: orderItems.productId,
      productName: orderItems.productName,
      unitPaise: orderItems.unitPaise,
      quantity: orderItems.quantity,
      orderId: orderItems.orderId,
      createdAt: orders.createdAt,
      orderSubtotal: orders.subtotalPaise,
      orderDiscount: orders.discountPaise,
      orderCoinsSpent: orders.coinsSpent,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orderItems.sellerOrgId, sellerOrgId), sql`${orders.status} != 'cancelled'`));

  const [activeProducts] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(products)
    .where(and(eq(products.sellerOrgId, sellerOrgId), eq(products.isActive, true)));

  let totalSalesVolumePaise = 0;
  let cashRevenuePaise = 0;
  let coinsRedeemedDiscountPaise = 0;
  let totalCoinsRedeemed = 0;
  let totalUnitsSoldCount = 0;
  const distinctOrders = new Set<number>();

  const productStats = new Map<number, { name: string; units: number; revenue: number }>();
  const monthlyStats = new Map<
    string,
    { sales: number; cash: number; coins: number; orders: Set<number> }
  >();

  for (const it of items) {
    const itemTotal = it.unitPaise * it.quantity;
    totalSalesVolumePaise += itemTotal;
    totalUnitsSoldCount += it.quantity;
    distinctOrders.add(it.orderId);

    const ratio = it.orderSubtotal > 0 ? itemTotal / it.orderSubtotal : 1;
    const itemDiscount = Math.round(it.orderDiscount * ratio);
    const itemCoins = Math.round(it.orderCoinsSpent * ratio);
    const itemCash = itemTotal - itemDiscount;

    coinsRedeemedDiscountPaise += itemDiscount;
    totalCoinsRedeemed += itemCoins;
    cashRevenuePaise += itemCash;

    // Product breakdown
    const currP = productStats.get(it.productId) ?? { name: it.productName, units: 0, revenue: 0 };
    currP.units += it.quantity;
    currP.revenue += itemTotal;
    productStats.set(it.productId, currP);

    // Monthly breakdown
    const month = it.createdAt.toISOString().slice(0, 7); // YYYY-MM
    const currM = monthlyStats.get(month) ?? { sales: 0, cash: 0, coins: 0, orders: new Set() };
    currM.sales += itemTotal;
    currM.cash += itemCash;
    currM.coins += itemCoins;
    currM.orders.add(it.orderId);
    monthlyStats.set(month, currM);
  }

  const topProducts = Array.from(productStats.entries())
    .map(([productId, stats]) => ({
      productId,
      productName: stats.name,
      unitsSold: stats.units,
      revenuePaise: stats.revenue,
    }))
    .sort((a, b) => b.unitsSold - a.unitsSold)
    .slice(0, 5);

  const monthlySales = Array.from(monthlyStats.entries())
    .map(([month, stats]) => ({
      month,
      salesPaise: stats.sales,
      cashPaise: stats.cash,
      coinsSpent: stats.coins,
      ordersCount: stats.orders.size,
    }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6);

  return {
    totalSalesVolumePaise,
    cashRevenuePaise,
    coinsRedeemedDiscountPaise,
    totalCoinsRedeemed,
    totalOrdersCount: distinctOrders.size,
    totalUnitsSoldCount,
    activeProductsCount: activeProducts?.count ?? 0,
    topProducts,
    monthlySales,
  };
}
