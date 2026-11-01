import { moneySchema } from '@common/openapi/shared-schemas.ts';
import { z } from '@hono/zod-openapi';

/**
 * System economy settings schema (Part 7, Requirements 25 & 26).
 */
export const systemSettingsSchema = z
  .object({
    id: z.number().int().openapi({ example: 1 }),
    defaultCommissionRateBps: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .openapi({ example: 1000, description: 'Commission in basis points (1000 = 10%)' }),
    defaultCommissionPercent: z
      .number()
      .openapi({ example: 10.0, description: 'Calculated commission percentage' }),
    coinRedemptionFeeBps: z
      .number()
      .int()
      .min(0)
      .max(2000)
      .openapi({ example: 200, description: 'Fee on coin redemptions in bps (200 = 2%)' }),
    coinRedemptionFeePercent: z
      .number()
      .openapi({ example: 2.0, description: 'Calculated coin fee percentage' }),
    coinsPerRupee: z
      .number()
      .int()
      .positive()
      .openapi({ example: 10, description: '10 coins = 1 Rupee' }),
    coinValuePaise: z
      .number()
      .int()
      .positive()
      .openapi({ example: 10, description: 'Value of 1 coin in paise' }),
    maxDiscountPercent: z
      .number()
      .int()
      .min(0)
      .max(100)
      .openapi({ example: 20, description: 'Max allowable coin redemption %' }),
    payoutHoldDays: z
      .number()
      .int()
      .min(0)
      .openapi({ example: 7, description: 'Settlement hold period in days' }),
    updatedBy: z.number().int().nullable().openapi({ example: 1 }),
    updatedAt: z.string().openapi({ example: '2026-11-01T10:00:00.000Z' }),
  })
  .openapi('SystemSettings');

export const updateSystemSettingsBodySchema = z
  .object({
    defaultCommissionRateBps: z.number().int().min(0).max(5000).optional(),
    coinRedemptionFeeBps: z.number().int().min(0).max(2000).optional(),
    coinsPerRupee: z.number().int().positive().optional(),
    coinValuePaise: z.number().int().positive().optional(),
    maxDiscountPercent: z.number().int().min(0).max(100).optional(),
    payoutHoldDays: z.number().int().min(0).optional(),
  })
  .openapi('UpdateSystemSettingsBody');

export const sellerCommissionOverrideBodySchema = z
  .object({
    commissionRateBps: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .nullable()
      .openapi({
        example: 800,
        description: 'Seller override in basis points (800 = 8%), or null to inherit global default',
      }),
  })
  .openapi('SellerCommissionOverrideBody');

export const sellerCommissionOverrideSchema = z
  .object({
    sellerOrgId: z.number().int().openapi({ example: 42 }),
    sellerName: z.string().openapi({ example: 'GreenRoot Organics' }),
    commissionRateBps: z.number().int().nullable().openapi({ example: 800 }),
    commissionPercent: z.number().nullable().openapi({ example: 8.0 }),
    effectiveCommissionRateBps: z.number().int().openapi({ example: 800 }),
    effectiveCommissionPercent: z.number().openapi({ example: 8.0 }),
  })
  .openapi('SellerCommissionOverride');

export const settlementStatusSchema = z
  .enum(['pending', 'settled', 'cancelled'])
  .openapi({ example: 'pending' });

export const settlementTransactionTypeSchema = z
  .enum(['sale_commission', 'coin_subsidy', 'coin_fee', 'seller_payout'])
  .openapi({ example: 'sale_commission' });

export const payoutStatusSchema = z
  .enum(['pending', 'processing', 'completed', 'failed'])
  .openapi({ example: 'completed' });

export const orderSettlementSchema = z
  .object({
    id: z.number().int().openapi({ example: 101 }),
    orderId: z.number().int().openapi({ example: 55 }),
    orderNumber: z.string().openapi({ example: 'ECO-2026-00042' }),
    orderItemId: z.number().int().openapi({ example: 72 }),
    productName: z.string().openapi({ example: 'Bamboo Toothbrush (Pack of 4)' }),
    sellerOrgId: z.number().int().openapi({ example: 12 }),
    sellerName: z.string().openapi({ example: 'EcoLiving India' }),
    saleAmountPaise: moneySchema,
    coinsUsed: z.number().int().openapi({ example: 100 }),
    coinValuePaise: moneySchema,
    cashPaidPaise: moneySchema,
    commissionRateBps: z.number().int().openapi({ example: 1000 }),
    salesCommissionPaise: moneySchema,
    coinFeeRateBps: z.number().int().openapi({ example: 200 }),
    coinFeePaise: moneySchema,
    platformCommissionPaise: moneySchema,
    sellerPayoutPaise: moneySchema,
    status: settlementStatusSchema,
    payoutId: z.number().int().nullable().openapi({ example: null }),
    settledAt: z.string().nullable().openapi({ example: null }),
    createdAt: z.string().openapi({ example: '2026-11-01T10:00:00.000Z' }),
  })
  .openapi('OrderSettlement');

export const listSettlementsQuerySchema = z.object({
  sellerOrgId: z
    .string()
    .optional()
    .openapi({ param: { name: 'sellerOrgId', in: 'query' }, example: '12' }),
  status: settlementStatusSchema.optional().openapi({ param: { name: 'status', in: 'query' } }),
  cursor: z.string().optional().openapi({ param: { name: 'cursor', in: 'query' } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .openapi({ param: { name: 'limit', in: 'query' } }),
});

export const sellerPayoutSchema = z
  .object({
    id: z.number().int().openapi({ example: 10 }),
    payoutNumber: z.string().openapi({ example: 'PAY-2026-00001' }),
    sellerOrgId: z.number().int().openapi({ example: 12 }),
    sellerName: z.string().openapi({ example: 'EcoLiving India' }),
    totalAmountPaise: moneySchema,
    settlementCount: z.number().int().openapi({ example: 5 }),
    status: payoutStatusSchema,
    referenceNote: z.string().nullable().openapi({ example: 'Bank NEFT Ref: N123456789' }),
    processedBy: z.number().int().nullable().openapi({ example: 1 }),
    createdAt: z.string().openapi({ example: '2026-11-01T10:00:00.000Z' }),
  })
  .openapi('SellerPayout');

export const createPayoutBodySchema = z
  .object({
    sellerOrgId: z.number().int().openapi({ example: 12 }),
    settlementIds: z.array(z.number().int()).optional(),
    referenceNote: z.string().optional().openapi({ example: 'Monthly disbursement via UPI/NEFT' }),
  })
  .openapi('CreatePayoutBody');

export const settlementLedgerEntrySchema = z
  .object({
    id: z.number().int().openapi({ example: 501 }),
    settlementId: z.number().int().nullable().openapi({ example: 101 }),
    orderId: z.number().int().openapi({ example: 55 }),
    orderNumber: z.string().openapi({ example: 'ECO-2026-00042' }),
    orderItemId: z.number().int().nullable().openapi({ example: 72 }),
    sellerOrgId: z.number().int().openapi({ example: 12 }),
    sellerName: z.string().openapi({ example: 'EcoLiving India' }),
    transactionType: settlementTransactionTypeSchema,
    amountPaise: moneySchema,
    status: settlementStatusSchema,
    idempotencyKey: z.string().openapi({ example: 'order:55:item:72:sale_commission' }),
    note: z.string().nullable().openapi({ example: 'Platform 10% commission on item 72' }),
    createdAt: z.string().openapi({ example: '2026-11-01T10:00:00.000Z' }),
  })
  .openapi('SettlementLedgerEntry');

export const listLedgerQuerySchema = z.object({
  sellerOrgId: z
    .string()
    .optional()
    .openapi({ param: { name: 'sellerOrgId', in: 'query' }, example: '12' }),
  transactionType: settlementTransactionTypeSchema
    .optional()
    .openapi({ param: { name: 'transactionType', in: 'query' } }),
  orderId: z
    .string()
    .optional()
    .openapi({ param: { name: 'orderId', in: 'query' } }),
  cursor: z.string().optional().openapi({ param: { name: 'cursor', in: 'query' } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .openapi({ param: { name: 'limit', in: 'query' } }),
});

export const revenueAnalyticsSchema = z
  .object({
    grossMerchandiseValuePaise: moneySchema,
    totalCashCollectedPaise: moneySchema,
    totalCoinDiscountPaise: moneySchema,
    totalCoinsRedeemed: z.number().int().openapi({ example: 1250 }),
    platformRevenuePaise: moneySchema,
    platformSalesCommissionPaise: moneySchema,
    platformCoinFeesPaise: moneySchema,
    totalSellerPayoutsPaise: moneySchema,
    pendingSellerPayoutsPaise: moneySchema,
    settledSellerPayoutsPaise: moneySchema,
    netPlatformCashFlowPaise: moneySchema,
    monthlyBreakdown: z.array(
      z.object({
        month: z.string().openapi({ example: '2026-10' }),
        grossPaise: moneySchema,
        cashPaise: moneySchema,
        coinValuePaise: moneySchema,
        commissionPaise: moneySchema,
        payoutPaise: moneySchema,
        orderCount: z.number().int().openapi({ example: 25 }),
      }),
    ),
  })
  .openapi('RevenueAnalytics');
