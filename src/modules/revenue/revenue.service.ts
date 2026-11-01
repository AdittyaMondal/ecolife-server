import { DomainError } from '@common/errors/domain-error.ts';
import { db } from '@database/client.ts';
import { auditLogs } from '@database/schema/index.ts';
import * as repo from './revenue.repository.ts';

function serialiseSettings(row: repo.SystemSettingsRow) {
  return {
    id: row.id,
    defaultCommissionRateBps: row.defaultCommissionRateBps,
    defaultCommissionPercent: row.defaultCommissionRateBps / 100,
    coinRedemptionFeeBps: row.coinRedemptionFeeBps,
    coinRedemptionFeePercent: row.coinRedemptionFeeBps / 100,
    coinsPerRupee: row.coinsPerRupee,
    coinValuePaise: row.coinValuePaise,
    maxDiscountPercent: row.maxDiscountPercent,
    payoutHoldDays: row.payoutHoldDays,
    updatedBy: row.updatedBy ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getSettings() {
  const row = await repo.getSystemSettings();
  return serialiseSettings(row);
}

export async function updateSettings(
  patch: Partial<{
    defaultCommissionRateBps: number;
    coinRedemptionFeeBps: number;
    coinsPerRupee: number;
    coinValuePaise: number;
    maxDiscountPercent: number;
    payoutHoldDays: number;
  }>,
  adminUserId: number,
) {
  const oldRow = await repo.getSystemSettings();
  const updated = await repo.updateSystemSettings(patch, adminUserId);

  // Write audit log
  await db.insert(auditLogs).values({
    actorUserId: adminUserId,
    actorType: 'admin',
    action: 'update_system_settings',
    entityType: 'system_settings',
    entityId: '1',
    oldValues: oldRow as unknown as Record<string, unknown>,
    newValues: updated as unknown as Record<string, unknown>,
  });

  return serialiseSettings(updated);
}

export async function getSellerOverride(sellerOrgId: number) {
  const settings = await repo.getSystemSettings();
  const override = await repo.getSellerCommission(sellerOrgId);
  if (!override) {
    throw new DomainError('REV_002', `Seller with ID ${sellerOrgId} not found`, 404);
  }

  const effectiveBps = override.commissionRateBps ?? settings.defaultCommissionRateBps;

  return {
    sellerOrgId: override.sellerOrgId,
    sellerName: override.sellerName,
    commissionRateBps: override.commissionRateBps,
    commissionPercent: override.commissionRateBps != null ? override.commissionRateBps / 100 : null,
    effectiveCommissionRateBps: effectiveBps,
    effectiveCommissionPercent: effectiveBps / 100,
  };
}

export async function setSellerOverride(
  sellerOrgId: number,
  commissionRateBps: number | null,
  adminUserId: number,
) {
  const settings = await repo.getSystemSettings();
  const existing = await repo.getSellerCommission(sellerOrgId);
  if (!existing) {
    throw new DomainError('REV_002', `Seller with ID ${sellerOrgId} not found`, 404);
  }

  const updated = await repo.setSellerCommission(sellerOrgId, commissionRateBps);
  if (!updated) {
    throw new DomainError('REV_002', `Seller with ID ${sellerOrgId} not found`, 404);
  }

  // Write audit log
  await db.insert(auditLogs).values({
    actorUserId: adminUserId,
    actorType: 'admin',
    action: 'set_seller_commission_override',
    entityType: 'organizations',
    entityId: String(sellerOrgId),
    oldValues: { commissionRateBps: existing.commissionRateBps },
    newValues: { commissionRateBps: updated.commissionRateBps },
  });

  const effectiveBps = updated.commissionRateBps ?? settings.defaultCommissionRateBps;

  return {
    sellerOrgId: updated.sellerOrgId,
    sellerName: updated.sellerName,
    commissionRateBps: updated.commissionRateBps,
    commissionPercent: updated.commissionRateBps != null ? updated.commissionRateBps / 100 : null,
    effectiveCommissionRateBps: effectiveBps,
    effectiveCommissionPercent: effectiveBps / 100,
  };
}

export async function settlements(opts: {
  sellerOrgId?: string;
  status?: 'pending' | 'settled' | 'cancelled';
  cursor?: string;
  limit?: number;
}) {
  const sellerId = opts.sellerOrgId ? Number.parseInt(opts.sellerOrgId, 10) : undefined;
  const res = await repo.listSettlements({
    sellerOrgId: Number.isNaN(sellerId) ? undefined : sellerId,
    status: opts.status,
    cursor: opts.cursor,
    limit: opts.limit,
  });

  return {
    items: res.items.map((s) => ({
      ...s,
      settledAt: s.settledAt ? s.settledAt.toISOString() : null,
      createdAt: s.createdAt.toISOString(),
    })),
    pageInfo: res.pageInfo,
  };
}

export async function ledger(opts: {
  sellerOrgId?: string;
  orderId?: string;
  transactionType?: 'sale_commission' | 'coin_subsidy' | 'coin_fee' | 'seller_payout';
  cursor?: string;
  limit?: number;
}) {
  const sellerId = opts.sellerOrgId ? Number.parseInt(opts.sellerOrgId, 10) : undefined;
  const orderId = opts.orderId ? Number.parseInt(opts.orderId, 10) : undefined;
  const res = await repo.listLedger({
    sellerOrgId: Number.isNaN(sellerId) ? undefined : sellerId,
    orderId: Number.isNaN(orderId) ? undefined : orderId,
    transactionType: opts.transactionType,
    cursor: opts.cursor,
    limit: opts.limit,
  });

  return {
    items: res.items.map((e) => ({
      ...e,
      createdAt: e.createdAt.toISOString(),
    })),
    pageInfo: res.pageInfo,
  };
}

export async function payouts(opts: {
  sellerOrgId?: string;
  cursor?: string;
  limit?: number;
}) {
  const sellerId = opts.sellerOrgId ? Number.parseInt(opts.sellerOrgId, 10) : undefined;
  const res = await repo.listPayouts({
    sellerOrgId: Number.isNaN(sellerId) ? undefined : sellerId,
    cursor: opts.cursor,
    limit: opts.limit,
  });

  return {
    items: res.items.map((p) => ({
      ...p,
      createdAt: p.createdAt.toISOString(),
    })),
    pageInfo: res.pageInfo,
  };
}

export async function createPayout(
  body: {
    sellerOrgId: number;
    settlementIds?: number[];
    referenceNote?: string;
  },
  adminUserId: number,
) {
  const payout = await repo.createPayoutBatch({
    sellerOrgId: body.sellerOrgId,
    settlementIds: body.settlementIds,
    referenceNote: body.referenceNote,
    adminUserId,
  });

  if (!payout) {
    throw new DomainError(
      'REV_001',
      'No pending settlements available for disbursement to this seller',
      400,
    );
  }

  return {
    id: payout.id,
    payoutNumber: payout.payoutNumber,
    sellerOrgId: payout.sellerOrgId,
    sellerName: payout.sellerName,
    totalAmountPaise: payout.totalAmountPaise,
    settlementCount: payout.settlementCount,
    status: payout.status,
    referenceNote: payout.referenceNote ?? null,
    processedBy: payout.processedBy ?? null,
    createdAt: payout.createdAt.toISOString(),
  };
}

export async function analytics() {
  return repo.getRevenueAnalytics();
}
