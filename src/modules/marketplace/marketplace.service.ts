import { DomainError } from '@common/errors/domain-error.ts';
import { decodeIdCursor, type Page, toPage } from '@common/pagination.ts';
import { award } from '@common/rewards/rewards.ts';
import { env } from '@config/env.ts';
import { db } from '@database/client.ts';
import * as profileRepo from '@modules/profile/profile.repository.ts';
import * as repo from './marketplace.repository.ts';

/**
 * Marketplace (PRD-v2 §6.5). All money is integer paise, never a float.
 *
 * Coins buy a DISCOUNT, capped at 20% of subtotal. The cap is enforced three
 * times on purpose: here, so the user gets a usable error; in the quote, so
 * the client can show it; and by `orders_discount_within_cap` in the
 * database, so a bug in either cannot write a row that breaks the rule.
 */

/** A line can hold at most this many of one product. */
const MAX_LINE_QUANTITY = 20;

/** Paise bought by one coin. COINS_PER_RUPEE is coins per 100 paise. */
const paisePerCoin = () => 100 / env.COINS_PER_RUPEE;

type CartLine = Awaited<ReturnType<typeof repo.listCart>>[number];

export type Quote = {
  items: {
    productId: number;
    product: CartLine['product'];
    quantity: number;
    lineTotalPaise: number;
  }[];
  subtotalPaise: number;
  maxDiscountPaise: number;
  discountPaise: number;
  totalPaise: number;
  coinsSpent: number;
  coinsBalanceAfter: number;
  coinsPerRupee: number;
  capReached: boolean;
};

/**
 * Prices a cart, server-side, always.
 *
 * `offeredCoins` is a request, not an instruction: it is clamped by the
 * wallet and by the 20% cap, and the result says how many were actually
 * spent. A client that asks to spend more than it holds gets a smaller
 * discount, not an error — the cart screen should keep working while the
 * user adjusts, and the ORDER path is where an impossible spend is refused.
 */
export function quote(lines: CartLine[], coinsBalance: number, offeredCoins: number): Quote {
  const items = lines.map((l) => ({
    productId: l.product.id,
    product: l.product,
    quantity: l.quantity,
    lineTotalPaise: l.product.pricePaise * l.quantity,
  }));

  const subtotalPaise = items.reduce((n, i) => n + i.lineTotalPaise, 0);
  const maxDiscountPaise = Math.floor((subtotalPaise * env.MAX_DISCOUNT_PCT) / 100);

  const coinsSpent = Math.max(
    0,
    Math.min(offeredCoins, coinsBalance, Math.floor(maxDiscountPaise / paisePerCoin())),
  );
  const discountPaise = coinsSpent * paisePerCoin();

  return {
    items,
    subtotalPaise,
    maxDiscountPaise,
    discountPaise,
    totalPaise: subtotalPaise - discountPaise,
    coinsSpent,
    coinsBalanceAfter: coinsBalance - coinsSpent,
    coinsPerRupee: env.COINS_PER_RUPEE,
    capReached: maxDiscountPaise > 0 && discountPaise >= maxDiscountPaise,
  };
}

async function quoteFor(userId: number, offeredCoins: number) {
  const [lines, user] = await Promise.all([repo.listCart(userId), profileRepo.findUser(userId)]);
  if (!user) throw new DomainError('AUTH_002', 'Not authenticated.', 401);
  return quote(lines, user.coinsBalance, offeredCoins);
}

export async function products(query: {
  category?: string;
  q?: string;
  sort: repo.Sort;
  cursor?: string;
  limit: number;
}) {
  const rows = await repo.listProducts({
    category: query.category,
    q: query.q,
    sort: query.sort,
    afterId: decodeIdCursor(query.cursor),
    limit: query.limit,
  });
  return toPage(rows, query.limit, (r) => r.id);
}

export async function product(slug: string) {
  const row = await repo.findProductBySlug(slug);
  if (!row) throw new DomainError('SHOP_005', 'Product not found.', 404);
  return row;
}

export const cart = (userId: number) => quoteFor(userId, 0);

export async function addToCart(userId: number, productId: number, quantity: number) {
  const found = await repo.findProduct(productId);
  if (!found) throw new DomainError('SHOP_005', 'Product not found.', 404);
  if (found.stock < quantity) {
    throw new DomainError('SHOP_001', 'Out of stock.', 422, { productId, stock: found.stock });
  }
  await repo.upsertCartLine(userId, productId, quantity, MAX_LINE_QUANTITY);
  return quoteFor(userId, 0);
}

/** `{id}` is a PRODUCT id — the cart's primary key is (user, product). */
export async function setQuantity(userId: number, productId: number, quantity: number) {
  if (quantity === 0) {
    await repo.removeCartLine(userId, productId);
    return quoteFor(userId, 0);
  }

  const found = await repo.findProduct(productId);
  if (!found) throw new DomainError('SHOP_005', 'Product not found.', 404);
  if (found.stock < quantity) {
    throw new DomainError('SHOP_001', 'Out of stock.', 422, { productId, stock: found.stock });
  }
  await repo.setCartQuantity(userId, productId, quantity);
  return quoteFor(userId, 0);
}

export async function removeFromCart(userId: number, productId: number) {
  await repo.removeCartLine(userId, productId);
  return quoteFor(userId, 0);
}

export const preview = (userId: number, offeredCoins: number) => quoteFor(userId, offeredCoins);

export type PlaceOrderBody = {
  offeredCoins: number;
  addressId: number;
  idempotencyKey: string;
};

/**
 * Places an order.
 *
 * Idempotent on `(userId, idempotencyKey)` via `order_idempotency_unq`, so a
 * retried or double-tapped checkout returns the original order instead of
 * charging twice. Everything else happens in one transaction: stock down,
 * order and snapshots in, coins debited, cart cleared. A failure at any
 * point leaves none of it.
 */
export async function placeOrder(userId: number, body: PlaceOrderBody) {
  const existing = await repo.findOrderByKey(userId, body.idempotencyKey);
  if (existing) {
    // A replay must return what the first call returned, address included.
    // It used to drop it, so a retried checkout — the ONE case this path
    // exists for — answered with a different shape than the original.
    const [items, replayed] = await Promise.all([
      itemsOf([existing.id]),
      existing.addressId ? repo.findAddress(userId, existing.addressId) : Promise.resolve(null),
    ]);
    return serialiseOrder(existing, items, replayed);
  }

  const [lines, user, address] = await Promise.all([
    repo.listCart(userId),
    profileRepo.findUser(userId),
    repo.findAddress(userId, body.addressId),
  ]);
  if (!user) throw new DomainError('AUTH_002', 'Not authenticated.', 401);
  if (lines.length === 0) throw new DomainError('SHOP_006', 'Your cart is empty.', 422);
  if (!address) throw new DomainError('SHOP_007', 'Delivery address not found.', 404);

  // Spending is refused outright here, unlike the cart quote: an order that
  // silently spent fewer coins than asked would charge a different total
  // than the one the user confirmed.
  if (body.offeredCoins > user.coinsBalance) {
    throw new DomainError('SHOP_003', 'You do not have that many coins.', 422, {
      offeredCoins: body.offeredCoins,
      coinsBalance: user.coinsBalance,
    });
  }

  const priced = quote(lines, user.coinsBalance, body.offeredCoins);

  return db.transaction(async (tx) => {
    for (const line of priced.items) {
      const left = await repo.decrementStock(tx, line.productId, line.quantity);
      if (!left) {
        throw new DomainError('SHOP_001', `${line.product.name} is out of stock.`, 422, {
          productId: line.productId,
        });
      }
    }

    const order = await repo.insertOrder(tx, {
      orderNumber: await repo.nextOrderNumber(tx),
      userId,
      addressId: address.id,
      subtotalPaise: priced.subtotalPaise,
      discountPaise: priced.discountPaise,
      totalPaise: priced.totalPaise,
      coinsSpent: priced.coinsSpent,
      idempotencyKey: body.idempotencyKey,
    });

    // Name and price are SNAPSHOTS. A later rename or repricing must not
    // rewrite what someone already bought.
    await repo.insertOrderItems(
      tx,
      priced.items.map((i) => ({
        orderId: order.id,
        productId: i.productId,
        productName: i.product.name,
        unitPaise: i.product.pricePaise,
        quantity: i.quantity,
      })),
    );

    if (priced.coinsSpent > 0) {
      // Negative coins, zero points: spending must never move the
      // leaderboard. The ledger's balance guard is what actually prevents
      // an overdraft under concurrency.
      await award(tx, {
        userId,
        pointsDelta: 0,
        coinsDelta: -priced.coinsSpent,
        source: 'order',
        sourceId: `order:${order.id}`,
        note: order.orderNumber,
      });
    }

    await repo.clearCart(userId, tx);

    const items = priced.items.map((i) => ({
      productName: i.product.name,
      unitPaise: i.product.pricePaise,
      quantity: i.quantity,
    }));
    return serialiseOrder(order, items, address);
  });
}

export async function orders(
  userId: number,
  limit: number,
  cursor: string | undefined,
): Promise<Page<ReturnType<typeof serialiseOrder>>> {
  const rows = await repo.listOrders(userId, limit, decodeIdCursor(cursor));
  const page = toPage(rows, limit, (r) => r.id);
  const [items, addresses] = await Promise.all([
    itemsOf(page.items.map((o) => o.id)),
    // One query for the whole page, not one per order. Serialising null here
    // forced the client to refetch every order by id to show a delivery line.
    repo.findAddressesByIds(userId, [
      ...new Set(page.items.map((o) => o.addressId).filter((id): id is number => id !== null)),
    ]),
  ]);
  const addressById = new Map(addresses.map((a) => [a.id, a]));

  return {
    items: page.items.map((o) =>
      serialiseOrder(
        o,
        items.filter((i) => i.orderId === o.id),
        o.addressId === null ? null : (addressById.get(o.addressId) ?? null),
      ),
    ),
    pageInfo: page.pageInfo,
  };
}

export async function order(userId: number, id: number) {
  const row = await repo.findOrder(userId, id);
  if (!row) throw new DomainError('SHOP_008', 'Order not found.', 404);
  const [items, address] = await Promise.all([
    itemsOf([row.id]),
    row.addressId ? repo.findAddress(userId, row.addressId) : Promise.resolve(null),
  ]);
  return serialiseOrder(row, items, address);
}

type OrderRow = Awaited<ReturnType<typeof repo.insertOrder>>;
type ItemRow = { orderId?: number; productName: string; unitPaise: number; quantity: number };

async function itemsOf(orderIds: number[]) {
  const rows = await repo.listOrderItems(orderIds);
  return rows as unknown as (ItemRow & { orderId: number })[];
}

function serialiseOrder(order: OrderRow, items: ItemRow[], address: repo.AddressRow | null) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    items: items.map((i) => ({
      productName: i.productName,
      unitPaise: i.unitPaise,
      quantity: i.quantity,
    })),
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
    totalPaise: order.totalPaise,
    coinsSpent: order.coinsSpent,
    status: order.status,
    address: address ? serialiseAddress(address) : null,
    createdAt: order.createdAt.toISOString(),
  };
}

// --- addresses -------------------------------------------------------------

export type AddressBody = {
  name: string;
  phone: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  pincode: string;
  isDefault: boolean;
};

export async function listAddresses(userId: number) {
  return { items: (await repo.listAddresses(userId)).map(serialiseAddress) };
}

export async function createAddress(userId: number, body: AddressBody) {
  return db.transaction(async (tx) => {
    // Clearing the old default and setting the new one must be one unit, or
    // a crash between them leaves the user with two defaults or none.
    if (body.isDefault) await repo.clearDefault(tx, userId);
    const row = await repo.insertAddress(tx, {
      userId,
      ...body,
      line2: body.line2 ?? null,
    });
    return serialiseAddress(row);
  });
}

export async function updateAddress(userId: number, id: number, body: Partial<AddressBody>) {
  return db.transaction(async (tx) => {
    const existing = await repo.findAddress(userId, id, tx);
    if (!existing) throw new DomainError('SHOP_007', 'Delivery address not found.', 404);
    if (body.isDefault) await repo.clearDefault(tx, userId, id);

    const row = await repo.updateAddress(tx, userId, id, {
      ...body,
      line2: body.line2 === undefined ? undefined : (body.line2 ?? null),
    });
    if (!row) throw new DomainError('SHOP_007', 'Delivery address not found.', 404);
    return serialiseAddress(row);
  });
}

export async function deleteAddress(userId: number, id: number) {
  const row = await repo.deleteAddress(userId, id);
  if (!row) throw new DomainError('SHOP_007', 'Delivery address not found.', 404);
  return { deleted: true as const };
}

function serialiseAddress(a: repo.AddressRow) {
  return {
    id: a.id,
    name: a.name,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    state: a.state,
    pincode: a.pincode,
    isDefault: a.isDefault,
  };
}
