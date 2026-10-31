import {
  bigint,
  bigserial,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { passStatus } from './enums.ts';
import { events } from './events.ts';
import { users } from './users.ts';

/**
 * A registration and its QR pass, one row (PRD-v2 §6.6.2, §7.5).
 *
 * `passCodeHash` stores only a SHA-256 of the code. The plaintext is shown to
 * its owner once, encoded into the QR as `ecolife://pass/{code}`, and never
 * persisted — so a database leak cannot be turned into a wallet of valid
 * passes. A random opaque code is simpler than a signed token and just as
 * safe, because the scan has to reach the server to credit the reward anyway;
 * there is nothing to verify offline.
 *
 * `scanClientId` is the offline scanner's replay key. The reward ledger
 * dedupes on event_attend:{passId}, so a queued scan replaying is a no-op.
 */
export const eventPasses = pgTable(
  'event_passes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventId: bigint('event_id', { mode: 'number' })
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    passCodeHash: text('pass_code_hash').notNull().unique(),
    status: passStatus('status').notNull().default('registered'),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    checkedInBy: bigint('checked_in_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    scanClientId: text('scan_client_id'),
  },
  (t) => [
    // Registering twice returns the existing pass rather than minting a second.
    uniqueIndex('event_pass_user_unq').on(t.eventId, t.userId),
    index('event_pass_event_status_idx').on(t.eventId, t.status),
  ],
);
