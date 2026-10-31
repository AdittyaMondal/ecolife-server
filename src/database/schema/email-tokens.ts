import { bigint, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.ts';

/**
 * PRD-v2 §7.2. Email verification and password reset.
 *
 * Hashed at rest and single-use (`usedAt`). The token's hash is the primary
 * key, so a lookup cannot be done by user and the row cannot be guessed.
 */
export const emailTokens = pgTable('email_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  userId: bigint('user_id', { mode: 'number' })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** 'verify' | 'reset' */
  purpose: text('purpose').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
