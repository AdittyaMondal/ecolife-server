import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import {
  commuteMode,
  cookingFuel,
  coolingUsage,
  dietType,
  freq3,
  kwhSource,
  level3,
  vehicleFuel,
  wasteHabit,
} from './enums.ts';
import { users } from './users.ts';

/**
 * The 15 onboarding answers and the baseline derived from them (PRD-v2 §3.2, §7.3).
 *
 * Every column here feeds a number in the baseline formula. If a question is
 * added that changes no emission figure and no recommendation, it does not
 * belong — v1 collected 32 answers and used 9.
 *
 * There is deliberately NO history table. v1 needed slowly-changing-dimension
 * rows to recompute past days after a profile edit; v2 copies the baseline onto
 * each daily_footprints row instead, which makes history immutable for free and
 * removes a whole table (PRD-v2 §3.3).
 */
export const lifestyleProfiles = pgTable('lifestyle_profiles', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' })
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),

  // --- Step 1: household ---
  householdSize: integer('household_size'),
  city: text('city'),
  regionCode: text('region_code'),
  coolingUsage: coolingUsage('cooling_usage'),

  // --- Step 2: food ---
  dietType: dietType('diet_type'),
  foodWasteLevel: level3('food_waste_level'),
  packagedFoodFreq: freq3('packaged_food_freq'),

  // --- Step 3: travel ---
  primaryCommuteMode: commuteMode('primary_commute_mode'),
  vehicleFuel: vehicleFuel('vehicle_fuel'),
  /** One way. Doubled, then weighted 5/7 — a commute does not happen at the weekend. */
  commuteDistanceKm: doublePrecision('commute_distance_km'),
  flightsPerYear: integer('flights_per_year'),

  // --- Step 4: home energy ---
  /**
   * Nullable on purpose: most people do not know their kWh. The client offers
   * exact kWh, the monthly bill divided by a seeded regional tariff, or
   * "I don't know" — and kwhSource records which, so the UI can label an
   * estimated footprint as an estimate rather than presenting it as fact.
   */
  electricityKwhMonth: doublePrecision('electricity_kwh_month'),
  electricityBillInr: integer('electricity_bill_inr'),
  kwhSource: kwhSource('kwh_source'),
  cookingFuel: cookingFuel('cooking_fuel'),
  hasSolar: boolean('has_solar'),

  // --- Step 5: water and waste ---
  waterUsageLevel: level3('water_usage_level'),
  wasteHabit: wasteHabit('waste_habit'),

  // --- Computed baseline, kg CO2e per day ---
  baselineTransportKg: doublePrecision('baseline_transport_kg'),
  baselineFoodKg: doublePrecision('baseline_food_kg'),
  baselineHomeEnergyKg: doublePrecision('baseline_home_energy_kg'),
  baselineWaterKg: doublePrecision('baseline_water_kg'),
  baselineWasteKg: doublePrecision('baseline_waste_kg'),
  baselineTotalKg: doublePrecision('baseline_total_kg'),

  // Components the DAILY calculation reuses rather than recomputing:
  /** Annual flights amortised to a per-day figure; daily logs never ask about flights. */
  baselineFlightKg: doublePrecision('baseline_flight_kg'),
  /** Cooking fuel per person per day; unaffected by what the user logs. */
  baselineCookKg: doublePrecision('baseline_cook_kg'),
  /** Non-cooling household electricity — lights, fridge — which stays at baseline. */
  baselineGridBaseKg: doublePrecision('baseline_grid_base_kg'),

  /** 0-5. Lets the wizard resume on any device. */
  completedSteps: integer('completed_steps').notNull().default(0),
  /** Which revision of the factor table produced the baseline above. */
  factorVersion: integer('factor_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
