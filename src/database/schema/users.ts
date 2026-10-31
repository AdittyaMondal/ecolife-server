import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { userRole } from './enums.ts';

/**
 * PRD-v2 §7.2.
 *
 * `pointsTotal` and `coinsBalance` are a denormalised cache of
 * reward_transactions, maintained in the same transaction as every ledger
 * write and reconcilable with one SUM. The CHECKs are the backstop: a bug in
 * the spend path cannot drive either negative.
 *
 * Points and coins are separate currencies on purpose (PRD-v2 §4.1). Points
 * only ever increase and drive rank; coins are spent. v1 used one integer for
 * both, so buying something dropped your leaderboard position.
 */
export const users = pgTable(
  'users',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('user'),
    avatarUrl: text('avatar_url'),
    city: text('city'),
    regionCode: text('region_code'),
    /** Every "today" in the app is this user's local date, never the server's. */
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    pointsTotal: integer('points_total').notNull().default(0),
    coinsBalance: integer('coins_balance').notNull().default(0),
    currentStreak: integer('current_streak').notNull().default(0),
    longestStreak: integer('longest_streak').notNull().default(0),
    onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * Uniqueness on lower(email), not on email.
     *
     * A plain unique column treats Alice@example.com and alice@example.com as
     * two accounts, which is both an identity-confusion bug (a login lookup
     * misses the row that exists) and the cheapest route to the multi-accounting
     * PRD-v2 §4.4 lists as a leaderboard-farming vector. Every lookup must use
     * lower(email) to hit this index.
     *
     * Not partial on deleted_at: account deletion anonymises PII (§6.8), which
     * frees the address without needing a conditional index.
     */
    uniqueIndex('users_email_lower_unq').on(sql`lower(${t.email})`),
    check('users_points_non_negative', sql`${t.pointsTotal} >= 0`),
    check('users_coins_non_negative', sql`${t.coinsBalance} >= 0`),
    // Leaderboard reads these on every Home render.
    index('users_points_idx').on(t.pointsTotal.desc()),
    index('users_region_points_idx').on(t.regionCode, t.pointsTotal.desc()),
  ],
);
