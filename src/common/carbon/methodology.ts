import {
  AC_HOURS_MIDPOINT,
  AC_KWH_PER_HOUR,
  AVG_FLIGHT_TRIP_KM,
  BATH_LITRES,
  COOKING_KG_CO2_PER_UNIT,
  COOKING_UNITS_PER_PERSON_MONTH,
  DIET_KG_PER_DAY,
  FACTOR_CAVEAT,
  FACTOR_VERSION,
  type Factor,
  FOOD_WASTE_MULTIPLIER,
  GRID_INDIA_AVG_KG_PER_KWH,
  INDUCTION_KWH_PER_PERSON_DAY,
  KWH_ESTIMATE_BASE,
  KWH_ESTIMATE_COOLING_ADDER,
  KWH_ESTIMATE_PER_PERSON,
  MSW_KG_PER_PERSON_DAY,
  OTHER_HOUSEHOLD_LITRES_PER_DAY,
  PACKAGED_FOOD_ADD_KG,
  SOLAR_OFFSET_MULTIPLIER,
  TRANSPORT_KG_PER_KM,
  WASTE_ACTION_DELTA,
  WASTE_HABIT_MULTIPLIER,
  WASTE_KG_CO2_PER_KG,
  WATER_KG_PER_LITRE,
  WATER_LITRES_PER_DAY,
} from './factors.ts';

/**
 * The factor table, flattened for `GET /carbon/methodology` (PRD-v2 §3.6).
 *
 * This lives next to `factors.ts` rather than in the reference module because
 * it must change in the same commit as the factors it publishes. A factor
 * added over there and missed here is a number the product shows a user and
 * cannot explain, which is the exact thing the public methodology page exists
 * to prevent.
 *
 * `METHODOLOGY_FACTORS` is derived, never hand-maintained: every group below
 * is a whole exported table, so a new entry in `factors.ts` appears here
 * automatically. The only hand-written part is the group's key prefix.
 */

export type PublishedFactor = Factor & { key: string };

/** `{ vegan: Factor }` + 'food.diet' -> `{ key: 'food.diet.vegan', ... }`. */
function group(prefix: string, table: Record<string, Factor>): PublishedFactor[] {
  return Object.entries(table).map(([name, factor]) => ({ key: `${prefix}.${name}`, ...factor }));
}

/** A table that is a single Factor rather than a record of them. */
const single = (key: string, factor: Factor): PublishedFactor => ({ key, ...factor });

export const METHODOLOGY_FACTORS: readonly PublishedFactor[] = [
  ...group('transport', TRANSPORT_KG_PER_KM),
  single('transport.avg_flight_trip_km', AVG_FLIGHT_TRIP_KM),

  ...group('food.diet', DIET_KG_PER_DAY),
  ...group('food.waste_multiplier', FOOD_WASTE_MULTIPLIER),
  ...group('food.packaged_add', PACKAGED_FOOD_ADD_KG),

  single('home_energy.grid_india_average', GRID_INDIA_AVG_KG_PER_KWH),
  single('home_energy.solar_offset', SOLAR_OFFSET_MULTIPLIER),
  ...group('home_energy.cooking_per_unit', COOKING_KG_CO2_PER_UNIT),
  ...group('home_energy.cooking_units_per_person_month', COOKING_UNITS_PER_PERSON_MONTH),
  single('home_energy.induction_kwh_per_person_day', INDUCTION_KWH_PER_PERSON_DAY),
  single('home_energy.ac_kwh_per_hour', AC_KWH_PER_HOUR),
  ...group('home_energy.ac_hours_midpoint', AC_HOURS_MIDPOINT),
  single('home_energy.kwh_estimate_base', KWH_ESTIMATE_BASE),
  single('home_energy.kwh_estimate_per_person', KWH_ESTIMATE_PER_PERSON),
  ...group('home_energy.kwh_estimate_cooling_adder', KWH_ESTIMATE_COOLING_ADDER),

  single('water.kg_per_litre', WATER_KG_PER_LITRE),
  ...group('water.litres_per_day', WATER_LITRES_PER_DAY),
  ...group('water.bath_litres', BATH_LITRES),
  single('water.other_household_litres_per_day', OTHER_HOUSEHOLD_LITRES_PER_DAY),

  single('waste.kg_co2_per_kg', WASTE_KG_CO2_PER_KG),
  single('waste.msw_kg_per_person_day', MSW_KG_PER_PERSON_DAY),
  ...group('waste.habit_multiplier', WASTE_HABIT_MULTIPLIER),
  ...group('waste.action_delta', WASTE_ACTION_DELTA),
] as const;

/**
 * When the published numbers last changed.
 *
 * Tied to FACTOR_VERSION, not to a build or a deploy: the page is a statement
 * about the factors, and `new Date()` here would claim the table changed every
 * time the server restarted.
 */
const V1_PUBLISHED = '2026-10-31T00:00:00.000Z';

export const FACTOR_VERSION_DATES: Readonly<Record<number, string>> = {
  1: V1_PUBLISHED,
};

export const METHODOLOGY = {
  factorVersion: FACTOR_VERSION,
  updatedAt: FACTOR_VERSION_DATES[FACTOR_VERSION] ?? V1_PUBLISHED,
  caveat: FACTOR_CAVEAT,
  factors: METHODOLOGY_FACTORS,
} as const;
