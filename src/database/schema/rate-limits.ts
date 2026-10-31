import { bigserial, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Fixed-window rate limiting (PRD-v2 §12).
 *
 * Postgres rather than Redis: at this scale one more table beats one more
 * piece of infrastructure, and the counter has to be shared across replicas
 * anyway. `windowStart` is truncated to the window size, so a row is one
 * (key, route-group, window) bucket and the increment is a single upsert.
 *
 * Rows are disposable — `sessions:prune` deletes expired ones nightly.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** `user:42`, or `ip:1.2.3.4` when unauthenticated, or `email:a@b.c`. */
    subject: text('subject').notNull(),
    bucket: text('bucket').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    // UNIQUE, not a plain index: the limiter increments with
    // `ON CONFLICT (subject, bucket, window_start) DO UPDATE`, and ON CONFLICT
    // requires a unique constraint to arbitrate against. With a plain index
    // every increment throws at runtime — which typecheck cannot see.
    uniqueIndex('rate_limit_bucket_unq').on(t.subject, t.bucket, t.windowStart),
  ],
);
