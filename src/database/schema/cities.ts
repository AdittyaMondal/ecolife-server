import { bigserial, index, pgTable, text } from 'drizzle-orm/pg-core';
import { regions } from './regions.ts';

/** PRD-v2 §7.7. Seeded, for the onboarding city autocomplete (question 2). */
export const cities = pgTable(
  'cities',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    regionCode: text('region_code')
      .notNull()
      .references(() => regions.code),
  },
  (t) => [index('cities_name_idx').on(t.name)],
);
