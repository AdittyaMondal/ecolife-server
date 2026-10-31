import { bigint, bigserial, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.ts';

/**
 * PRD-v2 §7.7. Registration ships in v2; the sender is deferred to v2.1.
 * The table exists now so the mobile client can register on first launch and
 * no migration is needed when notifications land.
 */
export const pushTokens = pgTable('push_tokens', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  platform: text('platform').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
