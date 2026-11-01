import type { Executor } from '@common/rewards/rewards.ts';
import { db } from '@database/client.ts';
import {
  orderItems,
  orderSettlements,
  orders,
  organizations,
  sellerPayouts,
  settlementLedger,
  systemSettings,
} from '@database/schema/index.ts';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';

export type SystemSettingsRow = typeof systemSettings.$inferSelect;
export type OrderSettlementRow = typeof orderSettlements.$inferSelect;
export type SettlementLedgerRow = typeof settlementLedger.$inferSelect;
export type SellerPayoutRow = typeof sellerPayouts.$inferSelect;

export const DEFAULT_SETTINGS = {
  id: 1,
  defaultCommissionRateBps: 1000, // 10.00%
  coinRedemptionFeeBps: 200, // 2.00%
  coinsPerRupee: 10,
  coinValuePaise: 10,
  maxDiscountPercent: 20,
  payoutHoldDays: 7,
} as const;

/**
 * Fetch system economy settings, seeding default row 1 if not yet initialized.
 */
export async function getSystemSettings(exec: Executor = db): Promise<SystemSettingsRow> {
  const existing = await exec
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.id, 1))
    .limit(1);

  const [first] = existing;
  if (first) {
    return first;
  }

  // Seed initial row
  const [seeded] = await exec
    .insert(systemSettings)
    .values({
      ...DEFAULT_SETTINGS,
      updatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();

  if (seeded) {
    return seeded;
  }

  const [row] = await exec.select().from(systemSettings).where(eq(systemSettings.id, 1)).limit(1);
  if (!row) {
    throw new Error('Failed to retrieve system settings');
  }
  return row;
}

export async function updateSystemSettings(
  patch: Partial<{
    defaultCommissionRateBps: number;
    coinRedemptionFeeBps: number;
    coinsPerRupee: number;
    coinValuePaise: number;
    maxDiscountPercent: number;
    payoutHoldDays: number;
  }>,
  adminUserId: number,
  exec: Executor = db,
): Promise<SystemSettingsRow> {
  // Ensure row 1 exists
  await getSystemSettings(exec);

  const [updated] = await exec
    .update(systemSettings)
    .set({
      ...patch,
      updatedBy: adminUserId,
      updatedAt: new Date(),
    })
    .where(eq(systemSettings.id, 1))
    .returning();

  return updated!;
}

export async function getSellerCommission(
  sellerOrgId: number,
  exec: Executor = db,
): Promise<{
  sellerOrgId: number;
  sellerName: string;
  commissionRateBps: number | null;
} | null> {
  const [org] = await exec
    .select({
      id: organizations.id,
      name: organizations.name,
      commissionRateBps: organizations.commissionRateBps,
    })
    .from(organizations)
    .where(and(eq(organizations.id, sellerOrgId), eq(organizations.type, 'seller')))
    .limit(1);

  if (!org) return null;
  return {
    sellerOrgId: org.id,
    sellerName: org.name,
    commissionRateBps: org.commissionRateBps,
  };
}

export async function setSellerCommission(
  sellerOrgId: number,
  commissionRateBps: number | null,
  exec: Executor = db,
): Promise<{
  sellerOrgId: number;
  sellerName: string;
  commissionRateBps: number | null;
} | null> {
  const [updated] = await exec
    .update(organizations)
    .set({
      commissionRateBps,
      updatedAt: new Date(),
    })
    .where(and(eq(organizations.id, sellerOrgId), eq(organizations.type, 'seller')))
    .returning({
      id: organizations.id,
      name: organizations.name,
      commissionRateBps: organizations.commissionRateBps,
    });

  if (!updated) return null;
  return {
    sellerOrgId: updated.id,
    sellerName: updated.name,
    commissionRateBps: updated.commissionRateBps,
  };
}

export async function insertSettlementAndLedger(
  settlementData: typeof orderSettlements.$inferInsert,
  ledgerEntries: (typeof settlementLedger.$inferInsert)[],
  exec: Executor,
): Promise<OrderSettlementRow> {
  const [settlement] = await exec
    .insert(orderSettlements)
    .values(settlementData)
    .returning();

  if (!settlement) {
    throw new Error('Failed to insert order settlement');
  }

  if (ledgerEntries.length > 0) {
    const entriesWithSettlementId = ledgerEntries.map((e) => ({
      ...e,
      settlementId: settlement.id,
    }));
    await exec.insert(settlementLedger).values(entriesWithSettlementId);
  }

  return settlement;
}

export async function listSettlements(
  opts: {
    sellerOrgId?: number;
    status?: 'pending' | 'settled' | 'cancelled';
    cursor?: string;
    limit?: number;
  },
  exec: Executor = db,
) {
  const limit = opts.limit ?? 20;
  const conditions = [];

  if (opts.sellerOrgId) {
    conditions.push(eq(orderSettlements.sellerOrgId, opts.sellerOrgId));
  }
  if (opts.status) {
    conditions.push(eq(orderSettlements.status, opts.status));
  }
  if (opts.cursor) {
    const cursorId = Number.parseInt(opts.cursor, 10);
    if (!Number.isNaN(cursorId)) {
      conditions.push(lt(orderSettlements.id, cursorId));
    }
  }

  const rows = await exec
    .select({
      settlement: orderSettlements,
      orderNumber: orders.orderNumber,
      productName: orderItems.productName,
      sellerName: organizations.name,
    })
    .from(orderSettlements)
    .innerJoin(orders, eq(orderSettlements.orderId, orders.id))
    .innerJoin(orderItems, eq(orderSettlements.orderItemId, orderItems.id))
    .innerJoin(organizations, eq(orderSettlements.sellerOrgId, organizations.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(orderSettlements.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? String(lastItem.settlement.id) : null;

  return {
    items: items.map((r) => ({
      ...r.settlement,
      orderNumber: r.orderNumber,
      productName: r.productName,
      sellerName: r.sellerName,
    })),
    pageInfo: {
      hasMore,
      nextCursor,
    },
  };
}

export async function listLedger(
  opts: {
    sellerOrgId?: number;
    orderId?: number;
    transactionType?: 'sale_commission' | 'coin_subsidy' | 'coin_fee' | 'seller_payout';
    cursor?: string;
    limit?: number;
  },
  exec: Executor = db,
) {
  const limit = opts.limit ?? 50;
  const conditions = [];

  if (opts.sellerOrgId) {
    conditions.push(eq(settlementLedger.sellerOrgId, opts.sellerOrgId));
  }
  if (opts.orderId) {
    conditions.push(eq(settlementLedger.orderId, opts.orderId));
  }
  if (opts.transactionType) {
    conditions.push(eq(settlementLedger.transactionType, opts.transactionType));
  }
  if (opts.cursor) {
    const cursorId = Number.parseInt(opts.cursor, 10);
    if (!Number.isNaN(cursorId)) {
      conditions.push(lt(settlementLedger.id, cursorId));
    }
  }

  const rows = await exec
    .select({
      entry: settlementLedger,
      orderNumber: orders.orderNumber,
      sellerName: organizations.name,
    })
    .from(settlementLedger)
    .innerJoin(orders, eq(settlementLedger.orderId, orders.id))
    .innerJoin(organizations, eq(settlementLedger.sellerOrgId, organizations.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(settlementLedger.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? String(lastItem.entry.id) : null;

  return {
    items: items.map((r) => ({
      ...r.entry,
      orderNumber: r.orderNumber,
      sellerName: r.sellerName,
    })),
    pageInfo: {
      hasMore,
      nextCursor,
    },
  };
}

export async function listPayouts(
  opts: {
    sellerOrgId?: number;
    cursor?: string;
    limit?: number;
  },
  exec: Executor = db,
) {
  const limit = opts.limit ?? 20;
  const conditions = [];

  if (opts.sellerOrgId) {
    conditions.push(eq(sellerPayouts.sellerOrgId, opts.sellerOrgId));
  }
  if (opts.cursor) {
    const cursorId = Number.parseInt(opts.cursor, 10);
    if (!Number.isNaN(cursorId)) {
      conditions.push(lt(sellerPayouts.id, cursorId));
    }
  }

  const rows = await exec
    .select({
      payout: sellerPayouts,
      sellerName: organizations.name,
    })
    .from(sellerPayouts)
    .innerJoin(organizations, eq(sellerPayouts.sellerOrgId, organizations.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(sellerPayouts.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? String(lastItem.payout.id) : null;

  return {
    items: items.map((r) => ({
      ...r.payout,
      sellerName: r.sellerName,
    })),
    pageInfo: {
      hasMore,
      nextCursor,
    },
  };
}

export async function createPayoutBatch(
  opts: {
    sellerOrgId: number;
    settlementIds?: number[];
    referenceNote?: string;
    adminUserId: number;
  },
  exec: Executor = db,
) {
  const conditions = [
    eq(orderSettlements.sellerOrgId, opts.sellerOrgId),
    eq(orderSettlements.status, 'pending'),
  ];

  if (opts.settlementIds && opts.settlementIds.length > 0) {
    conditions.push(inArray(orderSettlements.id, opts.settlementIds));
  }

  // Fetch eligible settlements
  const eligible = await exec
    .select()
    .from(orderSettlements)
    .where(and(...conditions));

  if (eligible.length === 0) {
    return null;
  }

  const totalAmountPaise = eligible.reduce((sum, s) => sum + s.sellerPayoutPaise, 0);
  const now = new Date();
  const year = now.getFullYear();
  const randomSuffix = Math.floor(10000 + Math.random() * 90000);
  const payoutNumber = `PAY-${year}-${randomSuffix}`;

  // 1. Create seller payout
  const [payout] = await exec
    .insert(sellerPayouts)
    .values({
      payoutNumber,
      sellerOrgId: opts.sellerOrgId,
      totalAmountPaise,
      settlementCount: eligible.length,
      status: 'completed',
      referenceNote: opts.referenceNote ?? null,
      processedBy: opts.adminUserId,
      createdAt: now,
    })
    .returning();

  if (!payout) {
    return null;
  }

  // 2. Mark settlements as settled
  const settlementIds = eligible.map((s) => s.id);
  await exec
    .update(orderSettlements)
    .set({
      status: 'settled',
      payoutId: payout.id,
      settledAt: now,
    })
    .where(inArray(orderSettlements.id, settlementIds));

  // 3. Add ledger records for seller payout
  const ledgerEntries = eligible.map((s) => ({
    settlementId: s.id,
    orderId: s.orderId,
    orderItemId: s.orderItemId,
    sellerOrgId: s.sellerOrgId,
    transactionType: 'seller_payout' as const,
    amountPaise: s.sellerPayoutPaise,
    status: 'settled' as const,
    idempotencyKey: `payout:${payout.id}:settlement:${s.id}`,
    note: `Disbursed in payout ${payoutNumber}`,
    createdAt: now,
  }));

  await exec.insert(settlementLedger).values(ledgerEntries);

  const [org] = await exec
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, opts.sellerOrgId))
    .limit(1);

  return {
    ...payout,
    sellerName: org?.name ?? 'Seller',
  };
}

export async function getRevenueAnalytics(exec: Executor = db) {
  // Aggregate totals from orderSettlements
  const [aggregates] = await exec
    .select({
      gmv: sql<number>`coalesce(sum(${orderSettlements.saleAmountPaise}), 0)::int`,
      cash: sql<number>`coalesce(sum(${orderSettlements.cashPaidPaise}), 0)::int`,
      coinDiscount: sql<number>`coalesce(sum(${orderSettlements.coinValuePaise}), 0)::int`,
      coinsRedeemed: sql<number>`coalesce(sum(${orderSettlements.coinsUsed}), 0)::int`,
      revenue: sql<number>`coalesce(sum(${orderSettlements.platformCommissionPaise}), 0)::int`,
      salesCommission: sql<number>`coalesce(sum(${orderSettlements.salesCommissionPaise}), 0)::int`,
      coinFees: sql<number>`coalesce(sum(${orderSettlements.coinFeePaise}), 0)::int`,
      payouts: sql<number>`coalesce(sum(${orderSettlements.sellerPayoutPaise}), 0)::int`,
      pendingPayouts: sql<number>`coalesce(sum(case when ${orderSettlements.status} = 'pending' then ${orderSettlements.sellerPayoutPaise} else 0 end), 0)::int`,
      settledPayouts: sql<number>`coalesce(sum(case when ${orderSettlements.status} = 'settled' then ${orderSettlements.sellerPayoutPaise} else 0 end), 0)::int`,
    })
    .from(orderSettlements);

  // Monthly breakdown for past 12 months
  const monthlyRows = await exec
    .select({
      month: sql<string>`to_char(${orderSettlements.createdAt}, 'YYYY-MM')`,
      grossPaise: sql<number>`coalesce(sum(${orderSettlements.saleAmountPaise}), 0)::int`,
      cashPaise: sql<number>`coalesce(sum(${orderSettlements.cashPaidPaise}), 0)::int`,
      coinValuePaise: sql<number>`coalesce(sum(${orderSettlements.coinValuePaise}), 0)::int`,
      commissionPaise: sql<number>`coalesce(sum(${orderSettlements.platformCommissionPaise}), 0)::int`,
      payoutPaise: sql<number>`coalesce(sum(${orderSettlements.sellerPayoutPaise}), 0)::int`,
      orderCount: sql<number>`count(distinct ${orderSettlements.orderId})::int`,
    })
    .from(orderSettlements)
    .groupBy(sql`to_char(${orderSettlements.createdAt}, 'YYYY-MM')`)
    .orderBy(desc(sql`to_char(${orderSettlements.createdAt}, 'YYYY-MM')`))
    .limit(12);

  const gmv = aggregates?.gmv ?? 0;
  const cash = aggregates?.cash ?? 0;
  const coinDiscount = aggregates?.coinDiscount ?? 0;
  const coinsRedeemed = aggregates?.coinsRedeemed ?? 0;
  const revenue = aggregates?.revenue ?? 0;
  const salesCommission = aggregates?.salesCommission ?? 0;
  const coinFees = aggregates?.coinFees ?? 0;
  const payouts = aggregates?.payouts ?? 0;
  const pendingPayouts = aggregates?.pendingPayouts ?? 0;
  const settledPayouts = aggregates?.settledPayouts ?? 0;
  const netPlatformCashFlowPaise = cash - settledPayouts;

  return {
    grossMerchandiseValuePaise: gmv,
    totalCashCollectedPaise: cash,
    totalCoinDiscountPaise: coinDiscount,
    totalCoinsRedeemed: coinsRedeemed,
    platformRevenuePaise: revenue,
    platformSalesCommissionPaise: salesCommission,
    platformCoinFeesPaise: coinFees,
    totalSellerPayoutsPaise: payouts,
    pendingSellerPayoutsPaise: pendingPayouts,
    settledSellerPayoutsPaise: settledPayouts,
    netPlatformCashFlowPaise,
    monthlyBreakdown: monthlyRows.reverse(),
  };
}
