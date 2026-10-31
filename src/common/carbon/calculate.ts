import {
  AVG_FLIGHT_TRIP_KM,
  CAR_KEY_BY_FUEL,
  COOKING_KG_CO2_PER_UNIT,
  COOKING_UNITS_PER_PERSON_MONTH,
  type CommuteMode,
  type CookingFuel,
  type CoolingUsage,
  DAYS_PER_MONTH,
  DAYS_PER_YEAR,
  DIET_KG_PER_DAY,
  type DietType,
  FACTOR_VERSION,
  FOOD_WASTE_MULTIPLIER,
  type Freq3,
  GRID_INDIA_AVG_KG_PER_KWH,
  INDUCTION_KWH_PER_PERSON_DAY,
  KWH_ESTIMATE_BASE,
  KWH_ESTIMATE_COOLING_ADDER,
  KWH_ESTIMATE_PER_PERSON,
  type KwhSource,
  type Level3,
  MIN_PLAUSIBLE_KG,
  MSW_KG_PER_PERSON_DAY,
  PACKAGED_FOOD_ADD_KG,
  SOLAR_OFFSET_MULTIPLIER,
  TRANSPORT_KG_PER_KM,
  type VehicleFuel,
  WASTE_HABIT_MULTIPLIER,
  WASTE_KG_CO2_PER_KG,
  WATER_KG_PER_LITRE,
  WATER_LITRES_PER_DAY,
  type WasteHabit,
  WORKING_DAY_RATIO,
} from './factors.ts';

/**
 * The baseline carbon engine — PRD-v2 §3.3, factors from Appendix A.
 *
 * Pure functions. No database, no clock, no I/O: the baseline is a function of
 * the 15 onboarding answers and the user's regional grid factor, nothing else.
 * That is what makes it unit-testable without a fixture, and what lets the
 * daily path reuse the three stored components instead of recomputing them.
 */

/**
 * The subset of `lifestyle_profiles` the baseline reads. Every field is
 * nullable because onboarding persists one step at a time (§3.2) — the wizard
 * must be able to render a half-finished profile without the server pretending
 * to know an answer it has not been given.
 */
export type BaselineProfile = {
  householdSize: number | null;
  coolingUsage: CoolingUsage | null;
  dietType: DietType | null;
  foodWasteLevel: Level3 | null;
  packagedFoodFreq: Freq3 | null;
  primaryCommuteMode: CommuteMode | null;
  vehicleFuel: VehicleFuel | null;
  commuteDistanceKm: number | null;
  flightsPerYear: number | null;
  electricityKwhMonth: number | null;
  kwhSource: KwhSource | null;
  cookingFuel: CookingFuel | null;
  hasSolar: boolean | null;
  waterUsageLevel: Level3 | null;
  wasteHabit: WasteHabit | null;
};

/** Field names match the `lifestyle_profiles` columns they are written to. */
export type DailyBaseline = {
  baselineTransportKg: number;
  baselineFoodKg: number;
  baselineHomeEnergyKg: number;
  baselineWaterKg: number;
  baselineWasteKg: number;
  baselineTotalKg: number;

  /** Annual flights amortised per day. The daily log never asks about flights. */
  baselineFlightKg: number;
  /** Cooking fuel per person per day. Unaffected by anything the user logs. */
  baselineCookKg: number;
  /** Non-cooling household electricity — the part a daily AC answer does not replace. */
  baselineGridBaseKg: number;

  /** The resolved monthly kWh and where it came from, for `lifestyle_profiles`. */
  kwhMonth: number;
  kwhSource: KwhSource;
  /** True when the total fell below MIN_PLAUSIBLE_KG and was raised to it. */
  clamped: boolean;
  factorVersion: number;
};

/**
 * The plausibility floor from Appendix A, applied to a day's headline total.
 *
 * Only the total is clamped, never the five categories: the floor is a
 * statement about the number we are willing to show and to pay a reduction
 * bonus on, not a redistribution across categories we have no basis for.
 */
export function clampDailyKg(totalKg: number): { totalKg: number; clamped: boolean } {
  return totalKg < MIN_PLAUSIBLE_KG
    ? { totalKg: MIN_PLAUSIBLE_KG, clamped: true }
    : { totalKg, clamped: false };
}

/**
 * kg CO2e per km for one commute mode.
 *
 * `mode` is widened to `string` because `daily_logs.trips[].mode` is free text
 * inside jsonb, so a client can send a mode the `commute_mode` enum does not
 * have — `ride_sharing` is the live example. An unknown mode throws rather
 * than returning 0: v1 zeroed a whole transport mode through an unhandled
 * switch case and nobody noticed, because a missing number looks exactly like
 * a good day.
 */
export function commuteFactorKgPerKm(mode: string | null, fuel: VehicleFuel | null): number {
  if (mode === null) return 0;

  switch (mode) {
    case 'walk':
    case 'cycle':
    case 'work_from_home':
    case 'bus':
    case 'metro_train':
    case 'auto_rickshaw':
    case 'cab':
    case 'ride_sharing':
      return TRANSPORT_KG_PER_KM[mode].value;
    // Appendix A publishes a petrol two-wheeler only. Any other fuel takes the
    // same number rather than an invented one — which overstates an electric
    // scooter, and is the first gap to close when Appendix A is reviewed.
    case 'two_wheeler':
      return TRANSPORT_KG_PER_KM.two_wheeler_petrol.value;
    case 'car':
      return TRANSPORT_KG_PER_KM[CAR_KEY_BY_FUEL[fuel ?? 'petrol']].value;
    default:
      throw new Error(`unknown transport mode: ${mode}`);
  }
}

/**
 * Appendix A's fallback for the ~most users who do not know their kWh:
 * `60 + 35 x householdSize + coolingAdder`. The region does not enter here —
 * it enters through the grid factor applied to the result.
 */
export function estimateKwhMonth(householdSize: number, cooling: CoolingUsage): number {
  return (
    KWH_ESTIMATE_BASE.value +
    KWH_ESTIMATE_PER_PERSON.value * householdSize +
    KWH_ESTIMATE_COOLING_ADDER[cooling].value
  );
}

/**
 * The reported kWh, or the estimate, plus which one it is.
 *
 * With no household size there is nothing to estimate from, so the result is
 * zero rather than a number invented out of the two defaults — a profile that
 * has not finished step 1 has not told us anything about its home energy.
 * A bill in rupees is converted to kWh at the regional tariff when onboarding
 * writes the answer (§3.2), so by the time the baseline runs, `kwhSource`
 * already says `from_bill` and `electricityKwhMonth` is set.
 */
export function resolveKwhMonth(profile: BaselineProfile): {
  kwhMonth: number;
  kwhSource: KwhSource;
} {
  if (profile.electricityKwhMonth !== null) {
    return { kwhMonth: profile.electricityKwhMonth, kwhSource: profile.kwhSource ?? 'reported' };
  }
  if (profile.householdSize === null) return { kwhMonth: 0, kwhSource: 'estimated' };

  return {
    kwhMonth: estimateKwhMonth(profile.householdSize, profile.coolingUsage ?? 'none'),
    kwhSource: 'estimated',
  };
}

/**
 * Cooking fuel, kg CO2e per person per day.
 *
 * Appendix A quotes every cooking input per PERSON (3.5 kg LPG/person/month,
 * 0.9 kWh/person/day), so this is NOT divided by household size again. §3.3's
 * `COOK_FUEL[...] / household_size` would divide a per-capita figure by the
 * household a second time and understate a family of four fourfold.
 *
 * Induction draws from the grid, but the solar multiplier is deliberately not
 * applied: §3.3 puts it on `grid` only, and the baseline's split between
 * cooking and grid draw is what the daily calculation reuses.
 */
export function cookingKgPerPersonDay(fuel: CookingFuel | null, gridKgPerKwh: number): number {
  if (fuel === null) return 0;
  if (fuel === 'electric_induction') return INDUCTION_KWH_PER_PERSON_DAY.value * gridKgPerKwh;

  return (
    (COOKING_UNITS_PER_PERSON_MONTH[fuel].value * COOKING_KG_CO2_PER_UNIT[fuel].value) /
    DAYS_PER_MONTH
  );
}

/**
 * The baseline: kg CO2e per day, per category, from the 15 onboarding answers.
 *
 * An unanswered question contributes nothing to its term. The one exception is
 * monthly kWh, which Appendix A gives an explicit estimator for because most
 * people genuinely do not know it.
 *
 * `region` supplies the user's grid factor from the `regions` table; without
 * it the CEA national average stands in.
 */
export function computeDailyBaseline(
  profile: BaselineProfile,
  region?: { gridKgPerKwh: number } | null,
): DailyBaseline {
  const householdSize = Math.max(1, profile.householdSize ?? 1);
  const gridKgPerKwh = region?.gridKgPerKwh ?? GRID_INDIA_AVG_KG_PER_KWH.value;

  // --- Transport ---------------------------------------------------------
  // Out and back, on weekdays only.
  const commuteKg =
    (profile.commuteDistanceKm ?? 0) *
    2 *
    commuteFactorKgPerKm(profile.primaryCommuteMode, profile.vehicleFuel) *
    WORKING_DAY_RATIO;
  const baselineFlightKg =
    ((profile.flightsPerYear ?? 0) * AVG_FLIGHT_TRIP_KM.value * TRANSPORT_KG_PER_KM.flight.value) /
    DAYS_PER_YEAR;
  const baselineTransportKg = commuteKg + baselineFlightKg;

  // --- Food --------------------------------------------------------------
  // The multiplier and the adder default to their own neutral Appendix A
  // values (low = 1.00, rarely = +0), so neither invents a number.
  const dietKg = profile.dietType === null ? 0 : DIET_KG_PER_DAY[profile.dietType].value;
  const baselineFoodKg =
    dietKg * FOOD_WASTE_MULTIPLIER[profile.foodWasteLevel ?? 'low'].value +
    PACKAGED_FOOD_ADD_KG[profile.packagedFoodFreq ?? 'rarely'].value;

  // --- Home energy -------------------------------------------------------
  const { kwhMonth, kwhSource } = resolveKwhMonth(profile);
  const solarMultiplier = profile.hasSolar ? SOLAR_OFFSET_MULTIPLIER.value : 1;
  const perPersonPerDay = (kwh: number) =>
    (((kwh * gridKgPerKwh) / DAYS_PER_MONTH) * solarMultiplier) / householdSize;
  // The cooling share is split out so the daily AC answer can replace it while
  // lights and the fridge stay at baseline (§3.5). Floored at zero: a reported
  // kWh can be lower than the cooling adder for the user's stated habit.
  const coolingKwhMonth = KWH_ESTIMATE_COOLING_ADDER[profile.coolingUsage ?? 'none'].value;
  const baselineGridBaseKg = perPersonPerDay(Math.max(0, kwhMonth - coolingKwhMonth));
  const baselineCookKg = cookingKgPerPersonDay(profile.cookingFuel, gridKgPerKwh);
  const baselineHomeEnergyKg = perPersonPerDay(kwhMonth) + baselineCookKg;

  // --- Water -------------------------------------------------------------
  const baselineWaterKg =
    profile.waterUsageLevel === null
      ? 0
      : WATER_LITRES_PER_DAY[profile.waterUsageLevel].value * WATER_KG_PER_LITRE.value;

  // --- Waste -------------------------------------------------------------
  const baselineWasteKg =
    profile.wasteHabit === null
      ? 0
      : MSW_KG_PER_PERSON_DAY.value *
        WASTE_HABIT_MULTIPLIER[profile.wasteHabit].value *
        WASTE_KG_CO2_PER_KG.value;

  const { totalKg, clamped } = clampDailyKg(
    baselineTransportKg + baselineFoodKg + baselineHomeEnergyKg + baselineWaterKg + baselineWasteKg,
  );

  return {
    baselineTransportKg,
    baselineFoodKg,
    baselineHomeEnergyKg,
    baselineWaterKg,
    baselineWasteKg,
    baselineTotalKg: totalKg,
    baselineFlightKg,
    baselineCookKg,
    baselineGridBaseKg,
    kwhMonth,
    kwhSource,
    clamped,
    factorVersion: FACTOR_VERSION,
  };
}
