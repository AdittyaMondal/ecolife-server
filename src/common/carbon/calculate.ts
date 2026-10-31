import {
  AC_HOURS_MIDPOINT,
  AC_KWH_PER_HOUR,
  type AcHoursBucket,
  AVG_FLIGHT_TRIP_KM,
  BATH_LITRES,
  type BathChoice,
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
  MEALS_PER_DAY,
  MIN_PLAUSIBLE_KG,
  MSW_KG_PER_PERSON_DAY,
  OTHER_HOUSEHOLD_LITRES_PER_DAY,
  PACKAGED_FOOD_ADD_KG,
  SOLAR_OFFSET_MULTIPLIER,
  TRANSPORT_KG_PER_KM,
  type VehicleFuel,
  WASTE_ACTION_DELTA,
  WASTE_HABIT_MULTIPLIER,
  WASTE_KG_CO2_PER_KG,
  WASTE_MULTIPLIER_FLOOR,
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

// ---------------------------------------------------------------------------
// The daily footprint — PRD-v2 §3.4, §3.5
// ---------------------------------------------------------------------------

/** One trip as the client sends it. `mode` is free text inside jsonb. */
export type LoggedTrip = { mode: string; km: number };

/**
 * The 5 daily answers. `undefined` means the question was SKIPPED, and that
 * category falls back to its baseline value.
 *
 * `trips: []` is therefore meaningfully different from `trips: undefined` —
 * an empty array is the user saying "I did not travel today", which is a
 * logged zero, while the absent key is "I did not answer", which inherits
 * the commute they described at onboarding.
 */
export type DailyAnswers = {
  trips?: LoggedTrip[];
  vegMeals?: number;
  nonVegMeals?: number;
  veganMeals?: number;
  acHoursBucket?: AcHoursBucket;
  bathChoice?: BathChoice;
  wasteActions?: string[];
};

/** The stored baseline components a daily calculation reuses. */
export type StoredBaseline = {
  baselineTransportKg: number;
  baselineFoodKg: number;
  baselineHomeEnergyKg: number;
  baselineWaterKg: number;
  baselineWasteKg: number;
  baselineTotalKg: number;
  baselineFlightKg: number;
  baselineCookKg: number;
  baselineGridBaseKg: number;
};

/** The profile fields the daily path still needs. */
export type DailyContext = {
  householdSize: number | null;
  foodWasteLevel: Level3 | null;
  packagedFoodFreq: Freq3 | null;
  hasSolar: boolean | null;
};

export type CategorySource = 'logged' | 'inferred';

/**
 * All five categories, always present.
 *
 * Deliberately a closed record rather than `Record<string, ...>`: the wire
 * contract declares all five keys, and a partial object would typecheck here
 * only to come out of the API missing a field the clients index into.
 */
export type CategorySources = {
  transport: CategorySource;
  food: CategorySource;
  home_energy: CategorySource;
  water: CategorySource;
  waste: CategorySource;
};

export type DailyFootprint = {
  transportKg: number;
  foodKg: number;
  homeEnergyKg: number;
  waterKg: number;
  wasteKg: number;
  totalKg: number;
  /** Per category, whether a real answer or the baseline produced the number. */
  sources: CategorySources;
  /** How many of the five questions were answered. The reduction bonus needs all 5. */
  answeredCount: number;
  clamped: boolean;
  factorVersion: number;
};

/**
 * Multiplier for the day's waste, from the actions taken.
 *
 * Starts at 1.00 (everything to landfill) and subtracts per action, floored
 * at WASTE_MULTIPLIER_FLOOR. An unknown action contributes nothing rather
 * than throwing: unlike a transport mode, where a missing factor silently
 * zeroes a whole category, an unrecognised waste action can only fail to
 * apply a discount the user might have earned — visible, and never an
 * understated footprint.
 */
export function wasteMultiplierFromActions(actions: readonly string[]): number {
  let multiplier = 1;
  for (const action of actions) {
    const delta = WASTE_ACTION_DELTA[action as keyof typeof WASTE_ACTION_DELTA];
    if (delta) multiplier += delta.value;
  }
  return Math.max(WASTE_MULTIPLIER_FLOOR, multiplier);
}

/** Grid draw from a daily AC-hours bucket, per person, at the region's factor. */
export function acGridKg(
  bucket: AcHoursBucket,
  gridKgPerKwh: number,
  householdSize: number,
  hasSolar: boolean,
): number {
  const hours = AC_HOURS_MIDPOINT[bucket].value;
  const solar = hasSolar ? SOLAR_OFFSET_MULTIPLIER.value : 1;
  return (hours * AC_KWH_PER_HOUR.value * gridKgPerKwh * solar) / Math.max(1, householdSize);
}

/**
 * One day's footprint from the 5 answers, with the baseline filling the gaps.
 *
 * Pure, like the baseline: no database, no clock. The caller supplies the
 * stored baseline and the region, so this is unit-testable without a fixture
 * and cannot drift from what was persisted on the day.
 *
 * A skipped question is NOT zero. A number built from four inferences and one
 * answer is marked as such in `sources`, because the Home screen shows that
 * distinction — presenting it with the same confidence as a fully logged day
 * would be a quiet lie.
 */
export function computeDailyFootprint(
  answers: DailyAnswers,
  baseline: StoredBaseline,
  profile: DailyContext,
  region?: { gridKgPerKwh: number } | null,
): DailyFootprint {
  const householdSize = Math.max(1, profile.householdSize ?? 1);
  const gridKgPerKwh = region?.gridKgPerKwh ?? GRID_INDIA_AVG_KG_PER_KWH.value;
  // --- Transport ---------------------------------------------------------
  // Flights stay amortised from the baseline: the daily log never asks about
  // them, so a logged day must not look cheaper simply by omitting them.
  let transportKg: number;
  const transportLogged = answers.trips !== undefined;
  if (answers.trips === undefined) {
    transportKg = baseline.baselineTransportKg;
  } else {
    const tripsKg = answers.trips.reduce(
      (sum, t) => sum + t.km * commuteFactorKgPerKm(t.mode, null),
      0,
    );
    transportKg = tripsKg + baseline.baselineFlightKg;
  }

  // --- Food --------------------------------------------------------------
  const mealsAnswered =
    answers.vegMeals !== undefined ||
    answers.nonVegMeals !== undefined ||
    answers.veganMeals !== undefined;
  let foodKg: number;
  if (!mealsAnswered) {
    foodKg = baseline.baselineFoodKg;
  } else {
    const perMeal = (kgPerDay: number) => kgPerDay / MEALS_PER_DAY;
    const mealsKg =
      (answers.vegMeals ?? 0) * perMeal(DIET_KG_PER_DAY.vegetarian.value) +
      (answers.veganMeals ?? 0) * perMeal(DIET_KG_PER_DAY.vegan.value) +
      (answers.nonVegMeals ?? 0) * perMeal(DIET_KG_PER_DAY.non_veg_daily.value);
    // The profile's waste multiplier and packaging adder still apply: neither
    // is something the five daily questions ask about.
    foodKg =
      mealsKg * FOOD_WASTE_MULTIPLIER[profile.foodWasteLevel ?? 'low'].value +
      PACKAGED_FOOD_ADD_KG[profile.packagedFoodFreq ?? 'rarely'].value;
  }

  // --- Home energy -------------------------------------------------------
  // Cooking and the non-cooling grid base stay at baseline; only the cooling
  // share is replaced by today's answer (§3.5).
  let homeEnergyKg: number;
  const homeEnergyLogged = answers.acHoursBucket !== undefined;
  if (answers.acHoursBucket === undefined) {
    homeEnergyKg = baseline.baselineHomeEnergyKg;
  } else {
    homeEnergyKg =
      baseline.baselineCookKg +
      baseline.baselineGridBaseKg +
      acGridKg(answers.acHoursBucket, gridKgPerKwh, householdSize, profile.hasSolar ?? false);
  }

  // --- Water -------------------------------------------------------------
  let waterKg: number;
  const waterLogged = answers.bathChoice !== undefined;
  if (answers.bathChoice === undefined) {
    waterKg = baseline.baselineWaterKg;
  } else {
    // OTHER_HOUSEHOLD_LITRES_PER_DAY is added to the bath choice, as that
    // factor's own definition states. §3.5's one-line formula omits it, but
    // without it every logged day drops ~60% on water for no behavioural
    // reason — a standing bias in the reduction bonus, and the factor would
    // be dead code. Flagged for the Appendix A review.
    const litres = BATH_LITRES[answers.bathChoice].value + OTHER_HOUSEHOLD_LITRES_PER_DAY.value;
    waterKg = litres * WATER_KG_PER_LITRE.value;
  }

  // --- Waste -------------------------------------------------------------
  let wasteKg: number;
  const wasteLogged = answers.wasteActions !== undefined;
  if (answers.wasteActions === undefined) {
    wasteKg = baseline.baselineWasteKg;
  } else {
    wasteKg =
      MSW_KG_PER_PERSON_DAY.value *
      wasteMultiplierFromActions(answers.wasteActions) *
      WASTE_KG_CO2_PER_KG.value;
  }

  const mark = (logged: boolean): CategorySource => (logged ? 'logged' : 'inferred');
  const sources: CategorySources = {
    transport: mark(transportLogged),
    food: mark(mealsAnswered),
    home_energy: mark(homeEnergyLogged),
    water: mark(waterLogged),
    waste: mark(wasteLogged),
  };

  const answeredCount = Object.values(sources).filter((s) => s === 'logged').length;
  const { totalKg, clamped } = clampDailyKg(
    transportKg + foodKg + homeEnergyKg + waterKg + wasteKg,
  );

  return {
    transportKg,
    foodKg,
    homeEnergyKg,
    waterKg,
    wasteKg,
    totalKg,
    sources,
    answeredCount,
    clamped,
    factorVersion: FACTOR_VERSION,
  };
}

/** Percent below baseline, floored at 0. Never negative: a worse day is 0%, not -12%. */
export function reductionPct(totalKg: number, baselineTotalKg: number): number {
  if (baselineTotalKg <= 0) return 0;
  const pct = ((baselineTotalKg - totalKg) / baselineTotalKg) * 100;
  return pct > 0 ? Math.round(pct * 100) / 100 : 0;
}
