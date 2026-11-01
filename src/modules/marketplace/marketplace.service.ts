import { DomainError } from '@common/errors/domain-error.ts';
import { decodeIdCursor, type Page, toPage } from '@common/pagination.ts';
import { award } from '@common/rewards/rewards.ts';
import { env } from '@config/env.ts';
import { db } from '@database/client.ts';
import { organizations } from '@database/schema/index.ts';
import * as orgRepo from '@modules/organizations/organizations.repository.ts';
import * as profileRepo from '@modules/profile/profile.repository.ts';
import * as revenueRepo from '@modules/revenue/revenue.repository.ts';
import { inArray } from 'drizzle-orm';
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

export function calculateEffectivePrice(product: {
  pricePaise: number;
  discountType?: 'none' | 'percentage' | 'fixed' | null;
  discountValue?: number | null;
  discountStartDate?: Date | string | null;
  discountEndDate?: Date | string | null;
}): number {
  const now = new Date();
  if (product.discountStartDate && new Date(product.discountStartDate) > now) {
    return product.pricePaise;
  }
  if (product.discountEndDate && new Date(product.discountEndDate) < now) {
    return product.pricePaise;
  }
  if (product.discountType === 'percentage' && product.discountValue && product.discountValue > 0) {
    const discount = Math.floor((product.pricePaise * product.discountValue) / 100);
    return Math.max(0, product.pricePaise - discount);
  }
  if (product.discountType === 'fixed' && product.discountValue && product.discountValue > 0) {
    return Math.max(0, product.pricePaise - product.discountValue);
  }
  return product.pricePaise;
}

export function serialiseProduct(p: any) {
  const effectivePricePaise = calculateEffectivePrice(p);
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    category: p.category,
    pricePaise: p.pricePaise,
    effectivePricePaise,
    imageUrl: p.imageUrl,
    images:
      Array.isArray(p.images) && p.images.length > 0 ? p.images : p.imageUrl ? [p.imageUrl] : [],
    stock: p.stock,
    co2SavedKg: p.co2SavedKg,
    sellerOrgId: p.sellerOrgId ?? null,
    discountType: p.discountType ?? 'none',
    discountValue: p.discountValue ?? 0,
    discountStartDate: p.discountStartDate ? new Date(p.discountStartDate).toISOString() : null,
    discountEndDate: p.discountEndDate ? new Date(p.discountEndDate).toISOString() : null,
    allowCoinRedemption: p.allowCoinRedemption ?? true,
    maxCoinRedemptionPercent: p.maxCoinRedemptionPercent ?? 20,
    isActive: p.isActive ?? true,
  };
}

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
  const items = lines.map((l) => {
    const effectivePrice = calculateEffectivePrice(l.product);
    return {
      productId: l.product.id,
      product: l.product,
      quantity: l.quantity,
      lineTotalPaise: effectivePrice * l.quantity,
    };
  });

  const subtotalPaise = items.reduce((n, i) => n + i.lineTotalPaise, 0);

  /**
   * Two ceilings, and the discount obeys the LOWER of them.
   *
   * `MAX_DISCOUNT_PCT` is the global 20% rule (PRD-v2 §4.3), enforced in the
   * database by `orders_discount_within_cap`. The per-line ceiling is the
   * seller's own: `allowCoinRedemption` and `maxCoinRedemptionPercent` were
   * stored on `products` and then never read, so a product that opted out of
   * coin redemption still got discounted, and one that capped itself at 5%
   * still absorbed the full 20%. Summing each line's own allowance gives the
   * most coins this particular basket can absorb.
   *
   * Taking the min keeps the database CHECK satisfied by construction: the
   * result can only ever be smaller than the global cap, never larger.
   */
  const globalCapPaise = Math.floor((subtotalPaise * env.MAX_DISCOUNT_PCT) / 100);
  const lineCapPaise = items.reduce((n, i) => {
    const p = i.product;
    if (p.allowCoinRedemption === false) return n;
    const pct = p.maxCoinRedemptionPercent ?? env.MAX_DISCOUNT_PCT;
    return n + Math.floor((i.lineTotalPaise * pct) / 100);
  }, 0);
  const maxDiscountPaise = Math.min(globalCapPaise, lineCapPaise);

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
  return toPage(rows.map(serialiseProduct), query.limit, (r) => r.id);
}

export async function product(slug: string) {
  const row = await repo.findProductBySlug(slug);
  if (!row) throw new DomainError('SHOP_005', 'Product not found.', 404);
  return serialiseProduct(row);
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
    const insertedItems = await repo.insertOrderItems(
      tx,
      priced.items.map((i) => ({
        orderId: order.id,
        productId: i.productId,
        sellerOrgId: i.product.sellerOrgId ?? null,
        productName: i.product.name,
        /**
         * The price CHARGED, not the list price. An order item is a financial
         * record; snapshotting `pricePaise` while the line total was computed
         * from the discounted price made the row disagree with its own order,
         * so `unitPaise * quantity` did not reconcile against
         * `orders.subtotal_paise` and seller analytics over-reported revenue.
         */
        unitPaise: calculateEffectivePrice(i.product),
        quantity: i.quantity,
        status: 'placed' as const,
      })),
    );

    // Part 7: Platform Revenue & Seller Settlements (Requirements 27 & 28)
    const settings = await revenueRepo.getSystemSettings(tx);
    const sellerOrgIds = [
      ...new Set(
        insertedItems
          .map((i) => i.sellerOrgId)
          .filter((id): id is number => id !== null),
      ),
    ];
    const sellerOrgs =
      sellerOrgIds.length > 0
        ? await tx.select().from(organizations).where(inArray(organizations.id, sellerOrgIds))
        : [];
    const sellerOrgMap = new Map(sellerOrgs.map((o) => [o.id, o]));

    let runningDiscountPaise = 0;
    let runningCoins = 0;

    for (let idx = 0; idx < insertedItems.length; idx++) {
      const item = insertedItems[idx];
      if (!item) continue;
      const isLast = idx === insertedItems.length - 1;
      const lineSubtotal = item.unitPaise * item.quantity;

      let lineDiscountPaise = 0;
      let lineCoinsUsed = 0;

      if (order.subtotalPaise > 0 && order.discountPaise > 0) {
        if (isLast) {
          lineDiscountPaise = Math.max(0, order.discountPaise - runningDiscountPaise);
          lineCoinsUsed = Math.max(0, order.coinsSpent - runningCoins);
        } else {
          lineDiscountPaise = Math.floor(
            (lineSubtotal * order.discountPaise) / order.subtotalPaise,
          );
          lineCoinsUsed = Math.floor(
            (lineSubtotal * order.coinsSpent) / order.subtotalPaise,
          );
          runningDiscountPaise += lineDiscountPaise;
          runningCoins += lineCoinsUsed;
        }
      }

      if (item.sellerOrgId) {
        const sellerOrg = sellerOrgMap.get(item.sellerOrgId);
        const commissionRateBps =
          sellerOrg?.commissionRateBps ?? settings.defaultCommissionRateBps;
        const salesCommissionPaise = Math.round(
          (lineSubtotal * commissionRateBps) / 10000,
        );
        const coinFeeRateBps = settings.coinRedemptionFeeBps;
        const coinFeePaise = Math.round((lineDiscountPaise * coinFeeRateBps) / 10000);
        const platformCommissionPaise = salesCommissionPaise + coinFeePaise;
        const sellerPayoutPaise = lineSubtotal - platformCommissionPaise;

        // Platform loss-prevention invariant
        if (sellerPayoutPaise < 0 || platformCommissionPaise > lineSubtotal) {
          throw new DomainError(
            'SHOP_009',
            'Settlement calculation results in negative seller payout or platform deficit',
            422,
            {
              productId: item.productId,
              sellerPayoutPaise,
              platformCommissionPaise,
            },
          );
        }

        const cashPaidPaise = lineSubtotal - lineDiscountPaise;

        await revenueRepo.insertSettlementAndLedger(
          {
            orderId: order.id,
            orderItemId: item.id,
            sellerOrgId: item.sellerOrgId,
            saleAmountPaise: lineSubtotal,
            coinsUsed: lineCoinsUsed,
            coinValuePaise: lineDiscountPaise,
            cashPaidPaise,
            commissionRateBps,
            salesCommissionPaise,
            coinFeeRateBps,
            coinFeePaise,
            platformCommissionPaise,
            sellerPayoutPaise,
            status: 'pending',
          },
          [
            {
              orderId: order.id,
              orderItemId: item.id,
              sellerOrgId: item.sellerOrgId,
              transactionType: 'sale_commission',
              amountPaise: salesCommissionPaise,
              status: 'pending',
              idempotencyKey: `order:${order.id}:item:${item.id}:sale_commission`,
              note: `Platform ${commissionRateBps / 100}% commission on item ${item.id}`,
            },
            {
              orderId: order.id,
              orderItemId: item.id,
              sellerOrgId: item.sellerOrgId,
              transactionType: 'coin_subsidy',
              amountPaise: lineDiscountPaise,
              status: 'pending',
              idempotencyKey: `order:${order.id}:item:${item.id}:coin_subsidy`,
              note: `Coin liability subsidy for ${lineCoinsUsed} coins on item ${item.id}`,
            },
            {
              orderId: order.id,
              orderItemId: item.id,
              sellerOrgId: item.sellerOrgId,
              transactionType: 'coin_fee',
              amountPaise: coinFeePaise,
              status: 'pending',
              idempotencyKey: `order:${order.id}:item:${item.id}:coin_fee`,
              note: `Coin redemption fee of ${coinFeeRateBps / 100}% on item ${item.id}`,
            },
            {
              orderId: order.id,
              orderItemId: item.id,
              sellerOrgId: item.sellerOrgId,
              transactionType: 'seller_payout',
              amountPaise: sellerPayoutPaise,
              status: 'pending',
              idempotencyKey: `order:${order.id}:item:${item.id}:seller_payout`,
              note: `Pending seller payout for item ${item.id}`,
            },
          ],
          tx,
        );
      }
    }

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
      // Must match what was just written to order_items, above.
      unitPaise: calculateEffectivePrice(i.product),
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

// --- Seller Portal Service Methods (Part 6) --------------------------------

export async function assertSeller(userId: number) {
  const membership = await orgRepo.findMembership(userId);
  if (!membership) {
    throw new DomainError('ORG_001', 'You do not belong to an organization.', 403);
  }
  if (membership.type !== 'seller') {
    throw new DomainError(
      'ORG_005',
      'Only Marketplace Partners (sellers) have access to the Seller Portal.',
      403,
    );
  }
  if (membership.status !== 'approved') {
    throw new DomainError(
      'ORG_002',
      'Your seller organization is pending review or suspended.',
      403,
      {
        status: membership.status,
      },
    );
  }
  /**
   * OWNER, not merely a member.
   *
   * `POST /organizations/join` grants membership to anyone who presents the
   * organization's six-digit code — no owner approval, and that module has no
   * rate limit. Checking only `type === 'seller'` therefore handed the entire
   * Seller Portal (edit their products, move their order statuses, read their
   * revenue) to anyone who learned or guessed a seller's join code. Joining by
   * code always lands `role: 'member'`, so requiring owner closes the path.
   *
   * If sellers ever need staff accounts, that wants an explicit seller-staff
   * role an owner grants — not the absence of a check.
   */
  if (membership.role !== 'owner') {
    throw new DomainError('ORG_004', 'Only an organization owner can do that.', 403);
  }
  return membership;
}

function uniqueProductSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'product';
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

export async function sellerProducts(
  userId: number,
  query: {
    category?: string;
    status: 'all' | 'active' | 'inactive';
    q?: string;
    cursor?: string;
    limit: number;
  },
) {
  const org = await assertSeller(userId);
  const rows = await repo.listSellerProducts({
    sellerOrgId: org.id,
    category: query.category,
    status: query.status,
    q: query.q,
    afterId: decodeIdCursor(query.cursor),
    limit: query.limit,
  });
  return toPage(rows.map(serialiseProduct), query.limit, (r) => r.id);
}

export async function createSellerProduct(userId: number, body: any) {
  const org = await assertSeller(userId);
  const slug = body.slug?.trim() || uniqueProductSlug(body.name);

  const images =
    Array.isArray(body.images) && body.images.length > 0
      ? body.images
      : body.imageUrl
        ? [body.imageUrl]
        : [];

  const row = await repo.insertProduct({
    name: body.name.trim(),
    slug,
    description: body.description?.trim() ?? null,
    category: body.category,
    pricePaise: body.pricePaise,
    imageUrl: body.imageUrl ?? (images[0] || null),
    images,
    stock: body.stock ?? 0,
    co2SavedKg: body.co2SavedKg ?? null,
    discountType: body.discountType ?? 'none',
    discountValue: body.discountValue ?? 0,
    discountStartDate: body.discountStartDate ? new Date(body.discountStartDate) : null,
    discountEndDate: body.discountEndDate ? new Date(body.discountEndDate) : null,
    allowCoinRedemption: body.allowCoinRedemption ?? true,
    maxCoinRedemptionPercent: body.maxCoinRedemptionPercent ?? 20,
    sellerOrgId: org.id,
    isActive: body.isActive ?? true,
  });

  return serialiseProduct(row);
}

export async function sellerProduct(userId: number, id: number) {
  const org = await assertSeller(userId);
  const row = await repo.findSellerProduct(org.id, id);
  if (!row) throw new DomainError('SHOP_005', 'Product not found.', 404);
  return serialiseProduct(row);
}

export async function updateSellerProduct(userId: number, id: number, body: any) {
  const org = await assertSeller(userId);
  const existing = await repo.findSellerProduct(org.id, id);
  if (!existing) throw new DomainError('SHOP_005', 'Product not found.', 404);

  const values: Record<string, any> = {};
  if (body.name !== undefined) values.name = body.name.trim();
  if (body.description !== undefined) values.description = body.description?.trim() ?? null;
  if (body.category !== undefined) values.category = body.category;
  if (body.pricePaise !== undefined) values.pricePaise = body.pricePaise;
  if (body.imageUrl !== undefined) values.imageUrl = body.imageUrl;
  if (body.images !== undefined) values.images = body.images;
  if (body.stock !== undefined) values.stock = body.stock;
  if (body.co2SavedKg !== undefined) values.co2SavedKg = body.co2SavedKg;
  if (body.discountType !== undefined) values.discountType = body.discountType;
  if (body.discountValue !== undefined) values.discountValue = body.discountValue;
  if (body.discountStartDate !== undefined)
    values.discountStartDate = body.discountStartDate ? new Date(body.discountStartDate) : null;
  if (body.discountEndDate !== undefined)
    values.discountEndDate = body.discountEndDate ? new Date(body.discountEndDate) : null;
  if (body.allowCoinRedemption !== undefined) values.allowCoinRedemption = body.allowCoinRedemption;
  if (body.maxCoinRedemptionPercent !== undefined)
    values.maxCoinRedemptionPercent = body.maxCoinRedemptionPercent;
  if (body.isActive !== undefined) values.isActive = body.isActive;

  const row = await repo.updateSellerProduct(org.id, id, values);
  if (!row) throw new DomainError('SHOP_005', 'Product not found.', 404);
  return serialiseProduct(row);
}

export async function deleteSellerProduct(userId: number, id: number) {
  const org = await assertSeller(userId);
  const existing = await repo.findSellerProduct(org.id, id);
  if (!existing) throw new DomainError('SHOP_005', 'Product not found.', 404);

  await repo.deleteSellerProduct(org.id, id);
  return { deleted: true as const };
}

export async function sellerOrders(
  userId: number,
  query: {
    status?: string;
    onlyRedemptions?: boolean;
    cursor?: string;
    limit: number;
  },
) {
  const org = await assertSeller(userId);
  const rows = await repo.listSellerOrders({
    sellerOrgId: org.id,
    status: query.status,
    onlyRedemptions: query.onlyRedemptions,
    afterId: decodeIdCursor(query.cursor),
    limit: query.limit,
  });
  return toPage(rows, query.limit, (r) => r.id);
}

/**
 * The only legal moves. Anything absent is refused rather than silently applied.
 *
 * Without this, `PATCH /seller/orders/{id}/status` accepted `delivered` ->
 * `placed`, and a cancelled line could be resurrected and shipped.
 */
export const ORDER_TRANSITIONS: Record<repo.OrderItemStatus, repo.OrderItemStatus[]> = {
  placed: ['confirmed', 'cancelled'],
  confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

/** How far through fulfilment a status is. Used to pick an order's weakest line. */
const FULFILMENT_RANK: Record<repo.OrderItemStatus, number> = {
  placed: 0,
  confirmed: 1,
  shipped: 2,
  delivered: 3,
  cancelled: 4,
};

/**
 * An order's status, derived from its lines rather than asserted by one seller.
 *
 * Every line cancelled means the order is cancelled. Otherwise the order is
 * only as far along as its LEAST advanced live line: a buyer whose second
 * seller has not shipped yet does not have a shipped order.
 */
export function deriveOrderStatus(statuses: repo.OrderItemStatus[]): repo.OrderItemStatus {
  const live = statuses.filter((x) => x !== 'cancelled');
  if (live.length === 0) return 'cancelled';
  return live.reduce((a, b) => (FULFILMENT_RANK[b] < FULFILMENT_RANK[a] ? b : a));
}

export async function updateSellerOrderStatus(
  userId: number,
  orderId: number,
  status: repo.OrderItemStatus,
) {
  const org = await assertSeller(userId);

  return db.transaction(async (tx) => {
    const all = await repo.lockOrderItems(orderId, tx);
    const mine = all.filter((i) => i.sellerOrgId === org.id);
    if (mine.length === 0) {
      throw new DomainError('SHOP_008', 'Order not found for this seller.', 404);
    }

    // Every line this seller owns has to be allowed to make the move. A
    // partially-legal batch is refused whole rather than half-applied.
    for (const item of mine) {
      if (item.status === status) continue;
      if (!ORDER_TRANSITIONS[item.status].includes(status)) {
        throw new DomainError(
          'SHOP_009',
          `An order item cannot go from ${item.status} to ${status}.`,
          422,
          { from: item.status, to: status },
        );
      }
    }

    const updated = await repo.setSellerItemsStatus(org.id, orderId, status, tx);

    /**
     * Cancelling returns the stock it reserved at checkout, in the same
     * transaction as the status change so the two cannot disagree.
     *
     * `ponytail:` the COINS spent on a cancelled line are not refunded. The
     * order carries one discount for the whole basket, and splitting it across
     * sellers is a product decision (pro-rata by line total? refuse partial
     * cancellation of a discounted order?), not something to guess at inside a
     * status handler. Upgrade path: attribute the discount per line at
     * checkout, then refund through `award()` with source `order_refund` —
     * which already exists in the enum and has no call sites.
     */
    if (status === 'cancelled') {
      for (const item of mine) {
        if (item.status !== 'cancelled') {
          await repo.restoreStock(item.productId, item.quantity, tx);
        }
      }
    }

    // Derived, never asserted: this seller's move only decides THEIR lines.
    const byId = new Map(updated.map((u) => [u.id, u.status as repo.OrderItemStatus]));
    const orderStatus = deriveOrderStatus(
      all.map((i) => byId.get(i.id) ?? (i.status as repo.OrderItemStatus)),
    );
    await repo.setOrderStatus(orderId, orderStatus, tx);

    return { success: true as const, status, orderStatus };
  });
}

export async function sellerAnalytics(userId: number) {
  const org = await assertSeller(userId);
  return repo.getSellerAnalytics(org.id);
}
