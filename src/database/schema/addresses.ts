import { bigint, bigserial, boolean, index, pgTable, text } from 'drizzle-orm/pg-core';
import { users } from './users.ts';

/** PRD-v2 §7.6. Delivery addresses for marketplace orders. */
export const addresses = pgTable(
  'addresses',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(),
    state: text('state').notNull(),
    pincode: text('pincode').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [index('addresses_user_idx').on(t.userId)],
);
