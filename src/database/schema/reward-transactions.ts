import {
  bigint,
  bigserial,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { rewardSource } from './enums.ts';
import { users } from './users.ts';

/**
 * The points and coins ledger (PRD-v2 §4.2, §7.4). Append-only.
 *
 * `reward_idempotency_unq` is the single most important constraint in the
 * schema. Every earn and spend path goes through one `award()` helper that
 * inserts here with ON CONFLICT DO NOTHING, so a replayed request — an offline
 * queue draining twice, a double-tapped button, a retried scan — grants
 * nothing the second time.
 *
 * It closes two P0 defects from v1 by construction rather than by review:
 *   - markAsCompleted() could be POSTed repeatedly for unbounded points
 *   - the challenge-progress route had no ownership check at all
 * Neither is reachable when the grant itself is keyed and unique.
 *
 * `sourceId` is a stable natural key, not a random one: 'goal:7',
 * 'event_attend:77', 'order:101', 'streak:30:4'. Two different awards must
 * never share one, and the same award must always produce the same one.
 */
export const rewardTransactions = pgTable(
  'reward_transactions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Signed. Points never go negative in practice; coins do, on a spend. */
    pointsDelta: integer('points_delta').notNull().default(0),
    coinsDelta: integer('coins_delta').notNull().default(0),
    source: rewardSource('source').notNull(),
    sourceId: text('source_id').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('reward_idempotency_unq').on(t.userId, t.source, t.sourceId),
    index('reward_user_time_idx').on(t.userId, t.createdAt.desc()),
  ],
);
