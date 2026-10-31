import {
  bigint,
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { dailyLogs } from './daily-logs.ts';
import { users } from './users.ts';

/** Which categories came from a real answer and which fell back to the baseline. */
export type CategorySources = Record<string, 'logged' | 'inferred'>;

/**
 * One row per user per day — the number the whole product is about (PRD-v2 §7.3).
 *
 * `baselineTotalKg` is the baseline AS IT WAS on this date, copied in at write
 * time. That single column is why v2 needs no profile-history table: editing
 * the profile changes tomorrow, never yesterday.
 *
 * `factorVersion` pins which revision of the factor table produced these
 * numbers, so changing a factor can never silently rewrite a user's history —
 * a methodology change bumps the version and backfills explicitly.
 */
export const dailyFootprints = pgTable(
  'daily_footprints',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    logDate: date('log_date').notNull(),
    dailyLogId: bigint('daily_log_id', { mode: 'number' }).references(() => dailyLogs.id, {
      onDelete: 'set null',
    }),

    transportKg: doublePrecision('transport_kg').notNull().default(0),
    foodKg: doublePrecision('food_kg').notNull().default(0),
    homeEnergyKg: doublePrecision('home_energy_kg').notNull().default(0),
    waterKg: doublePrecision('water_kg').notNull().default(0),
    wasteKg: doublePrecision('waste_kg').notNull().default(0),
    totalKg: doublePrecision('total_kg').notNull().default(0),

    baselineTotalKg: doublePrecision('baseline_total_kg').notNull(),
    reductionPct: doublePrecision('reduction_pct').notNull().default(0),
    sources: jsonb('sources').$type<CategorySources>().notNull(),
    /** True when the computed day fell below MIN_PLAUSIBLE_KG and was clamped. */
    clamped: boolean('clamped').notNull().default(false),
    factorVersion: integer('factor_version').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // v1 had no such constraint and relied on an app-level "where date = today"
    // check, which is a race. This makes the daily rollup safely idempotent via
    // ON CONFLICT (user_id, log_date) DO UPDATE.
    uniqueIndex('footprint_user_date_unq').on(t.userId, t.logDate),
    index('footprint_user_date_desc_idx').on(t.userId, t.logDate.desc()),
  ],
);
