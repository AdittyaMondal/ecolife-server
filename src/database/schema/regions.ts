import { doublePrecision, integer, pgTable, text } from 'drizzle-orm/pg-core';

/** PRD-v2 §7.7. Seeded reference data: per-region grid factor and tariff. */
export const regions = pgTable('regions', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  /** kg CO2e per kWh. India average is 0.71 (CEA); states differ materially. */
  gridKgPerKwh: doublePrecision('grid_kg_per_kwh').notNull(),
  /** Used to convert a reported monthly bill into kWh when the user doesn't know it. */
  tariffPaisePerKwh: integer('tariff_paise_per_kwh').notNull(),
});
