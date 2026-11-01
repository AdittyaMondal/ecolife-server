import { bigint, bigserial, jsonb, pgTable, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.ts';

export const userGardens = pgTable('user_gardens', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' })
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  gardenState: jsonb('garden_state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

