import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  date,
  doublePrecision,
  pgTable,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { goalPeriod, goalStatus, goalType } from './enums.ts';
import { users } from './users.ts';

/**
 * Reduction goals (PRD-v2 §6.4, §7.4).
 *
 * `targetKgTotal` is FROZEN at creation from a baseline snapshot. This is the
 * fix for v1's defect C1: it derived a percentage goal's target from the same
 * running total it then compared against, so the test was
 * `actual <= actual x (1 - p/100)`, false for every p > 0 — percentage goals
 * were mathematically unachievable. Computing the target once, up front, is the
 * whole fix.
 *
 * Goals are never deleted. They settle to 'achieved' or 'missed' and stay, so
 * the user keeps a history and the award stays idempotent against goal:{id}.
 * v1 deleted the row on success, which is why its points_awarded flag never
 * did anything.
 */
export const goals = pgTable(
  'goals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: goalType('type').notNull(),
    period: goalPeriod('period').notNull(),
    reducePercent: doublePrecision('reduce_percent'),
    capKgPerDay: doublePrecision('cap_kg_per_day'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),

    baselineKgTotal: doublePrecision('baseline_kg_total').notNull(),
    targetKgTotal: doublePrecision('target_kg_total').notNull(),

    status: goalStatus('status').notNull().default('active'),
    actualKgTotal: doublePrecision('actual_kg_total'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One active goal per user, enforced by the database rather than by a
    // service remembering to deactivate the others first.
    uniqueIndex('one_active_goal_per_user').on(t.userId).where(sql`${t.status} = 'active'`),
    check('goals_end_after_start', sql`${t.endDate} > ${t.startDate}`),
    check('goals_target_non_negative', sql`${t.targetKgTotal} >= 0`),
  ],
);
