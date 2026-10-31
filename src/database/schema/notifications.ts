import { sql } from 'drizzle-orm';
import { bigint, bigserial, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.ts';

/** PRD-v2 §7.7. In-app notifications; the push sender is deferred to v2.1. */
export const notifications = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    linkPath: text('link_path'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial index: the unread badge is the only hot query.
    index('notif_unread_idx').on(t.userId, t.createdAt.desc()).where(sql`${t.readAt} IS NULL`),
  ],
);
