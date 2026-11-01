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
import { payoutStatus, settlementStatus, settlementTransactionType } from './enums.ts';
import { orderItems, orders } from './orders.ts';
import { organizations } from './organizations.ts';
import { users } from './users.ts';

/**
 * Batch seller disbursement / payout records (PRD-v2 Part 7, Requirement 28).
 */
export const sellerPayouts = pgTable(
  'seller_payouts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    payoutNumber: text('payout_number').notNull().unique(),
    sellerOrgId: bigint('seller_org_id', { mode: 'number' })
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    totalAmountPaise: integer('total_amount_paise').notNull(),
    settlementCount: integer('settlement_count').notNull(),
    status: payoutStatus('status').notNull().default('completed'),
    referenceNote: text('reference_note'),
    processedBy: bigint('processed_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('seller_payouts_seller_idx').on(t.sellerOrgId, t.createdAt),
    check('seller_payouts_amount_positive', sql`${t.totalAmountPaise} >= 0`),
    check('seller_payouts_count_positive', sql`${t.settlementCount} > 0`),
  ],
);

/**
 * Line-item order settlements (PRD-v2 Part 7, Requirement 27).
 *
 * Designed so the platform never takes a loss:
 * 1. Seller payout = value of the sale (cash plus coin value) minus commission.
 * 2. Coin value credited to sellers is covered by the platform's coin liability pool,
 *    and commission is applied after the coin value is calculated.
 * 3. Enforces strict conservation of money and funding equivalence via Postgres check constraints.
 */
export const orderSettlements = pgTable(
  'order_settlements',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orderId: bigint('order_id', { mode: 'number' })
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    orderItemId: bigint('order_item_id', { mode: 'number' })
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    sellerOrgId: bigint('seller_org_id', { mode: 'number' })
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Line item total after product discounts, in paise */
    saleAmountPaise: integer('sale_amount_paise').notNull(),
    /** Apportioned EcoCoins spent on this line */
    coinsUsed: integer('coins_used').notNull().default(0),
    /** Rupee discount funded by coins (coinsUsed / coinsPerRupee * 100), in paise */
    coinValuePaise: integer('coin_value_paise').notNull().default(0),
    /** Cash paid by the customer for this line (saleAmountPaise - coinValuePaise) */
    cashPaidPaise: integer('cash_paid_paise').notNull(),
    /** Commission rate snapshot in basis points */
    commissionRateBps: integer('commission_rate_bps').notNull(),
    /** Platform sales commission in paise */
    salesCommissionPaise: integer('sales_commission_paise').notNull(),
    /** Platform coin redemption fee rate snapshot in basis points */
    coinFeeRateBps: integer('coin_fee_rate_bps').notNull(),
    /** Platform coin redemption fee in paise */
    coinFeePaise: integer('coin_fee_paise').notNull(),
    /** Total platform fee (salesCommissionPaise + coinFeePaise) in paise */
    platformCommissionPaise: integer('platform_commission_paise').notNull(),
    /** Net amount payable to the seller (saleAmountPaise - platformCommissionPaise) in paise */
    sellerPayoutPaise: integer('seller_payout_paise').notNull(),
    status: settlementStatus('status').notNull().default('pending'),
    payoutId: bigint('payout_id', { mode: 'number' }).references(() => sellerPayouts.id, {
      onDelete: 'set null',
    }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('order_settlement_item_unq').on(t.orderItemId),
    index('order_settlements_seller_status_idx').on(t.sellerOrgId, t.status),
    index('order_settlements_order_idx').on(t.orderId),
    check(
      'settlement_conservation_of_money',
      sql`${t.sellerPayoutPaise} + ${t.platformCommissionPaise} = ${t.saleAmountPaise}`,
    ),
    check(
      'settlement_customer_funding',
      sql`${t.cashPaidPaise} + ${t.coinValuePaise} = ${t.saleAmountPaise}`,
    ),
    check(
      'settlement_commission_sum',
      sql`${t.platformCommissionPaise} = ${t.salesCommissionPaise} + ${t.coinFeePaise}`,
    ),
    check(
      'settlement_non_negative',
      sql`${t.saleAmountPaise} >= 0 AND ${t.cashPaidPaise} >= 0 AND ${t.coinValuePaise} >= 0 AND ${t.platformCommissionPaise} >= 0 AND ${t.sellerPayoutPaise} >= 0`,
    ),
  ],
);

/**
 * Immutable financial transaction audit ledger (PRD-v2 Part 7, Requirement 28).
 */
export const settlementLedger = pgTable(
  'settlement_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    settlementId: bigint('settlement_id', { mode: 'number' }).references(
      () => orderSettlements.id,
      { onDelete: 'restrict' },
    ),
    orderId: bigint('order_id', { mode: 'number' })
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    orderItemId: bigint('order_item_id', { mode: 'number' }).references(() => orderItems.id, {
      onDelete: 'restrict',
    }),
    sellerOrgId: bigint('seller_org_id', { mode: 'number' })
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    transactionType: settlementTransactionType('transaction_type').notNull(),
    amountPaise: integer('amount_paise').notNull(),
    status: settlementStatus('status').notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('settlement_ledger_idempotency_unq').on(t.idempotencyKey),
    index('settlement_ledger_seller_type_idx').on(t.sellerOrgId, t.transactionType, t.createdAt),
    index('settlement_ledger_order_idx').on(t.orderId),
  ],
);
