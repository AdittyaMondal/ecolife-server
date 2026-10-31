import {
  bigint,
  bigserial,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { acHoursBucket, bathChoice } from './enums.ts';
import { users } from './users.ts';

/** One logged trip. `mode` matches the commute_mode enum. */
export type Trip = { mode: string; km: number };

/**
 * The 5 daily answers (PRD-v2 §3.4, §7.3). Target: under 30 seconds, one thumb.
 *
 * A NULL column means the user skipped that question, and the footprint falls
 * back to the baseline for that category — which is why these are nullable and
 * why daily_footprints records which categories were logged vs inferred.
 */
export const dailyLogs = pgTable(
  'daily_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The USER'S local date, resolved from users.timezone — never the server's. */
    logDate: date('log_date').notNull(),
    /**
     * Client-generated UUIDv7. This is what makes the mobile offline queue safe
     * to replay: the unique index below turns a duplicate submit into a no-op
     * instead of a second footprint and a second reward (PRD-v2 §10.3).
     */
    clientLogId: text('client_log_id').notNull(),

    trips: jsonb('trips').$type<Trip[]>(),
    vegMeals: integer('veg_meals'),
    nonVegMeals: integer('non_veg_meals'),
    veganMeals: integer('vegan_meals'),
    acHoursBucket: acHoursBucket('ac_hours_bucket'),
    bathChoice: bathChoice('bath_choice'),
    wasteActions: jsonb('waste_actions').$type<string[]>(),

    /** 0-5. The reduction bonus requires all five (PRD-v2 §4.4). */
    answeredCount: integer('answered_count').notNull().default(0),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('daily_log_user_date_unq').on(t.userId, t.logDate),
    uniqueIndex('daily_log_client_unq').on(t.userId, t.clientLogId),
  ],
);
