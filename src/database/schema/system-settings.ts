import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  integer,
  pgTable,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './users.ts';

/**
 * Platform Revenue and Coin Economy global settings (Part 7, Requirements 25 & 26).
 *
 * Singleton row pattern with check constraint id = 1.
 * Rates stored in integer basis points (bps) to prevent floating-point inaccuracies:
 * - 1000 bps = 10.00%
 * - 200 bps = 2.00%
 */
export const systemSettings = pgTable(
  'system_settings',
  {
    id: integer('id').primaryKey().default(1),
    /** Default platform sales commission rate in basis points (100 bps = 1%). Default: 1000 (10%) */
    defaultCommissionRateBps: integer('default_commission_rate_bps').notNull().default(1000),
    /** Platform fee on coin redemptions in basis points. Default: 200 (2%) */
    coinRedemptionFeeBps: integer('coin_redemption_fee_bps').notNull().default(200),
    /** Number of EcoCoins that equal 1 Rupee (10 coins = ₹1.00). Default: 10 */
    coinsPerRupee: integer('coins_per_rupee').notNull().default(10),
    /** Value of 1 coin in paise (1 coin = 10 paise). Default: 10 */
    coinValuePaise: integer('coin_value_paise').notNull().default(10),
    /** Maximum allowable coin redemption discount as % of line total. Default: 20 (20%) */
    maxDiscountPercent: integer('max_discount_percent').notNull().default(20),
    /** Holding period in days before a settlement becomes eligible for payout. Default: 7 */
    payoutHoldDays: integer('payout_hold_days').notNull().default(7),
    /** Admin user who last updated the settings. */
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('system_settings_singleton', sql`${t.id} = 1`),
    check(
      'system_settings_commission_range',
      sql`${t.defaultCommissionRateBps} >= 0 AND ${t.defaultCommissionRateBps} <= 5000`,
    ),
    check(
      'system_settings_coin_fee_range',
      sql`${t.coinRedemptionFeeBps} >= 0 AND ${t.coinRedemptionFeeBps} <= 2000`,
    ),
    check(
      'system_settings_coins_rate_positive',
      sql`${t.coinsPerRupee} > 0 AND ${t.coinValuePaise} > 0`,
    ),
    check(
      'system_settings_max_discount_range',
      sql`${t.maxDiscountPercent} >= 0 AND ${t.maxDiscountPercent} <= 100`,
    ),
  ],
);
