import type {
  acHoursBucket,
  bathChoice,
  commuteMode,
  cookingFuel,
  coolingUsage,
  dietType,
  freq3,
  kwhSource,
  level3,
  vehicleFuel,
  wasteHabit,
} from '@database/schema/enums.ts';

/**
 * Emission factors — PRD-v2 Appendix A. The single source of truth.
 *
 * Nothing else in this codebase may hardcode a factor. `factor_version` on
 * lifestyle_profiles and daily_footprints records which revision of THIS file
 * produced a number, so a constant that also lives somewhere else makes that
 * column a lie — and v1 duplicated the whole calculation in two classes with no
 * version marker at all (PRD-v2 §3.6).
 *
 * Changing a value means bumping FACTOR_VERSION and running an explicit
 * backfill. Never edit a number in place: a factor edit must not silently
 * rewrite a user's history.
 *
 * Every entry carries its own basis and source because this table is served
 * publicly at `GET /v1/carbon/methodology`. "Where does 0.71 come from?" has to
 * have an answer inside the product.
 */
export const FACTOR_VERSION = 1;

/** Appendix A's closing note, served verbatim as the methodology caveat. */
export const FACTOR_CAVEAT =
  'Defensible published averages, not measurements. India-weighted where India-specific data ' +
  'exists and global otherwise. Review before any public launch.';

export type Factor = {
  readonly value: number;
  readonly unit: string;
  readonly basis: string;
  readonly source: string;
};

/** Positional on purpose: value, unit, basis, source reads as a table row. */
const f = (value: number, unit: string, basis: string, source: string): Factor => ({
  value,
  unit,
  basis,
  source,
});

const APPENDIX_A = 'PRD-v2 Appendix A';
const SCARBOROUGH = 'Scarborough et al. 2014, Climatic Change — per 2000 kcal/day';

// Enum unions come from the database enums rather than being retyped here, so
// adding a value to `commute_mode` becomes a compile error in the resolver that
// has to handle it. v1's equivalent bug was an unhandled switch case that
// silently returned 0 for a whole transport mode.
export type CommuteMode = (typeof commuteMode.enumValues)[number];
export type VehicleFuel = (typeof vehicleFuel.enumValues)[number];
export type DietType = (typeof dietType.enumValues)[number];
export type Level3 = (typeof level3.enumValues)[number];
export type Freq3 = (typeof freq3.enumValues)[number];
export type CoolingUsage = (typeof coolingUsage.enumValues)[number];
export type CookingFuel = (typeof cookingFuel.enumValues)[number];
export type WasteHabit = (typeof wasteHabit.enumValues)[number];
export type BathChoice = (typeof bathChoice.enumValues)[number];
export type KwhSource = (typeof kwhSource.enumValues)[number];
export type AcHoursBucket = (typeof acHoursBucket.enumValues)[number];

// ---------------------------------------------------------------------------
// Formula constants (PRD-v2 §3.3)
//
// Calendar conventions and weightings, not emission factors — they carry no
// external source. They live here anyway so no formula hardcodes one.
// ---------------------------------------------------------------------------

/**
 * A commute does not happen at the weekend. Dropping this overstates transport
 * — the largest category for most users — by ~28%.
 */
export const WORKING_DAY_RATIO = 5 / 7;

/** Appendix A quotes cooking fuel and electricity per month; §3.3 divides by 30. */
export const DAYS_PER_MONTH = 30;

/** Flights are an annual answer amortised to a per-day figure. */
export const DAYS_PER_YEAR = 365;

/** Appendix A: "Per-meal = daily ÷ 3". */
export const MEALS_PER_DAY = 3;

// ---------------------------------------------------------------------------
// Guards (Appendix A — Guards)
// ---------------------------------------------------------------------------

/**
 * A computed day below this is clamped and flagged. It is the floor under the
 * reduction bonus: without it, answering "I did nothing today" is the cheapest
 * way to farm points (PRD-v2 §4.4).
 */
export const MIN_PLAUSIBLE_KG = 1.5;

// ---------------------------------------------------------------------------
// Transport — kg CO2e per km
// ---------------------------------------------------------------------------

/**
 * Keyed by mode, and by mode_fuel where the fuel changes the number. Resolve a
 * profile's (mode, fuel) pair through `commuteFactorKgPerKm` in calculate.ts;
 * do not index this table directly from a mode value.
 */
export const TRANSPORT_KG_PER_KM = {
  walk: f(0, 'kg CO2e/km', 'no fuel burned', APPENDIX_A),
  cycle: f(0, 'kg CO2e/km', 'no fuel burned', APPENDIX_A),
  work_from_home: f(0, 'kg CO2e/km', 'no commute', APPENDIX_A),
  bus: f(0.027, 'kg CO2e/km', 'per passenger-km, Indian urban bus occupancy', APPENDIX_A),
  metro_train: f(
    0.014,
    'kg CO2e/km',
    'per passenger-km, electrified rail at the India grid factor',
    APPENDIX_A,
  ),
  auto_rickshaw: f(0.065, 'kg CO2e/km', 'per passenger-km, CNG', APPENDIX_A),
  two_wheeler_petrol: f(0.051, 'kg CO2e/km', '45 km/l x 2.31 kg CO2/l petrol', APPENDIX_A),
  car_petrol: f(0.171, 'kg CO2e/km', '13.5 km/l x 2.31 kg CO2/l petrol', APPENDIX_A),
  car_diesel: f(0.15, 'kg CO2e/km', '17.9 km/l x 2.68 kg CO2/l diesel', APPENDIX_A),
  car_cng: f(0.12, 'kg CO2e/km', 'CNG passenger car', APPENDIX_A),
  car_electric: f(0.107, 'kg CO2e/km', '0.15 kWh/km x 0.71 kg CO2/kWh', APPENDIX_A),
  cab: f(0.222, 'kg CO2e/km', 'petrol car x 1.3 deadhead factor', APPENDIX_A),
  /**
   * An app-hailed shared ride is the same vehicle under the same deadhead
   * penalty as `cab`, so it takes the same factor. It is a separate key
   * because clients send this string: `daily_logs.trips[].mode` is free text
   * inside jsonb, not the `commute_mode` enum, and a mode the resolver does
   * not know must never fall through to 0 — that exact silent zero was a v1
   * defect.
   */
  ride_sharing: f(0.222, 'kg CO2e/km', 'as cab: petrol car x 1.3 deadhead factor', APPENDIX_A),
  flight: f(
    0.154,
    'kg CO2e/km',
    'per passenger-km, short-haul incl. radiative forcing uplift',
    APPENDIX_A,
  ),
} as const satisfies Record<string, Factor>;

/** One domestic return trip. `flights_per_year` is counted in trips, not legs. */
export const AVG_FLIGHT_TRIP_KM = f(2200, 'km', 'one domestic return trip', APPENDIX_A);

/**
 * Which transport key a car's fuel resolves to.
 *
 * `not_applicable` means the user answered the fuel question for a mode that
 * has no fuel, then changed their commute to a car. Petrol is the honest
 * default: it is the most common Indian private car and the one an unanswered
 * question is most likely to be.
 */
export const CAR_KEY_BY_FUEL = {
  petrol: 'car_petrol',
  diesel: 'car_diesel',
  cng: 'car_cng',
  electric: 'car_electric',
  not_applicable: 'car_petrol',
} as const satisfies Record<VehicleFuel, keyof typeof TRANSPORT_KG_PER_KM>;

// ---------------------------------------------------------------------------
// Food — kg CO2e per day
// ---------------------------------------------------------------------------

export const DIET_KG_PER_DAY = {
  vegan: f(2.89, 'kg CO2e/day', 'vegan cohort', SCARBOROUGH),
  vegetarian: f(3.81, 'kg CO2e/day', 'vegetarian cohort', SCARBOROUGH),
  eggetarian: f(3.91, 'kg CO2e/day', 'fish/ovo cohort', SCARBOROUGH),
  non_veg_weekly: f(4.67, 'kg CO2e/day', 'low meat-eater cohort', SCARBOROUGH),
  non_veg_daily: f(7.19, 'kg CO2e/day', 'high meat-eater cohort', SCARBOROUGH),
} as const satisfies Record<DietType, Factor>;

/** `low` is 1.00 — the neutral value, and therefore the default for no answer. */
export const FOOD_WASTE_MULTIPLIER = {
  low: f(1.0, 'multiplier', 'little food thrown away', APPENDIX_A),
  medium: f(1.08, 'multiplier', 'some food thrown away', APPENDIX_A),
  high: f(1.18, 'multiplier', 'frequent plate and fridge waste', APPENDIX_A),
} as const satisfies Record<Level3, Factor>;

/** `rarely` is +0 — the neutral value, and therefore the default for no answer. */
export const PACKAGED_FOOD_ADD_KG = {
  rarely: f(0, 'kg CO2e/day', 'packaging and cold chain, negligible', APPENDIX_A),
  sometimes: f(0.3, 'kg CO2e/day', 'packaging and cold chain', APPENDIX_A),
  often: f(0.7, 'kg CO2e/day', 'packaging and cold chain', APPENDIX_A),
} as const satisfies Record<Freq3, Factor>;

// ---------------------------------------------------------------------------
// Home energy
// ---------------------------------------------------------------------------

/** Fallback when a user's region is unknown. Per-region values live in `regions`. */
export const GRID_INDIA_AVG_KG_PER_KWH = f(
  0.71,
  'kg CO2/kWh',
  'weighted national average',
  'CEA CO2 Baseline Database',
);

export const SOLAR_OFFSET_MULTIPLIER = f(
  0.35,
  'multiplier on grid draw',
  'typical residential rooftop offset',
  APPENDIX_A,
);

export const COOKING_KG_CO2_PER_UNIT = {
  lpg: f(2.98, 'kg CO2/kg', 'LPG combustion', 'IPCC default for LPG'),
  png: f(2.0, 'kg CO2/SCM', 'piped natural gas combustion', APPENDIX_A),
  firewood: f(1.75, 'kg CO2/kg', 'partly biogenic — flagged in the methodology', APPENDIX_A),
} as const satisfies Record<Exclude<CookingFuel, 'electric_induction'>, Factor>;

/**
 * Consumption per person, so the figure is already per-capita.
 *
 * Appendix A gives no firewood consumption rate, only its emission factor. It
 * reuses LPG's 3.5 kg/person/month as a stand-in rather than inventing a new
 * number — placeholder pending the Appendix A review, and the reason firewood
 * lands between LPG and induction instead of above both.
 */
export const COOKING_UNITS_PER_PERSON_MONTH = {
  lpg: f(3.5, 'kg/person/month', 'household cylinder consumption', APPENDIX_A),
  png: f(1.5, 'SCM/person/month', 'household piped consumption', APPENDIX_A),
  firewood: f(3.5, 'kg/person/month', 'placeholder: LPG mass, pending review', APPENDIX_A),
} as const satisfies Record<Exclude<CookingFuel, 'electric_induction'>, Factor>;

/** Already per person, and billed at the region's grid factor. */
export const INDUCTION_KWH_PER_PERSON_DAY = f(
  0.9,
  'kWh/person/day',
  'induction hob at the grid factor',
  APPENDIX_A,
);

/** 1.5-ton split unit. Used by the daily AC-hours question, not by the baseline. */
export const AC_KWH_PER_HOUR = f(1.5, 'kWh/hour', '1.5-ton split unit', APPENDIX_A);

/**
 * Hours assumed for each daily AC bucket.
 *
 * The question asks for a bucket rather than a number because nobody knows
 * how long their AC ran, and a bucket answered honestly beats a figure
 * guessed precisely. Each value is the midpoint of its range; `8_plus` is
 * open-ended, so 10 stands in for "most of the night and then some" rather
 * than for its unbounded true mean.
 */
export const AC_HOURS_MIDPOINT = {
  '0': f(0, 'hours', 'AC not used', APPENDIX_A),
  '1_3': f(2, 'hours', 'midpoint of 1-3 hours', APPENDIX_A),
  '4_8': f(6, 'hours', 'midpoint of 4-8 hours', APPENDIX_A),
  '8_plus': f(10, 'hours', 'open-ended bucket, assumed 10 hours', APPENDIX_A),
} as const satisfies Record<AcHoursBucket, Factor>;

/** `estimateKwhMonth` = BASE + PER_PERSON x householdSize + the cooling adder. */
export const KWH_ESTIMATE_BASE = f(
  60,
  'kWh/month',
  'lights, fridge and standby, per household',
  APPENDIX_A,
);

export const KWH_ESTIMATE_PER_PERSON = f(35, 'kWh/month/person', 'per-person load', APPENDIX_A);

/**
 * Doubles as the cooling share of a REPORTED monthly kWh figure, which is what
 * splits home energy into `baseline_grid_base_kg` (lights, fridge — stays at
 * baseline) and the part the daily AC-hours answer replaces.
 */
export const KWH_ESTIMATE_COOLING_ADDER = {
  none: f(0, 'kWh/month', 'no cooling', APPENDIX_A),
  fan_only: f(20, 'kWh/month', 'ceiling fans', APPENDIX_A),
  ac_occasional: f(90, 'kWh/month', 'AC on some evenings', APPENDIX_A),
  ac_daily: f(220, 'kWh/month', 'AC every night', APPENDIX_A),
} as const satisfies Record<CoolingUsage, Factor>;

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

export const WATER_KG_PER_LITRE = f(0.0003, 'kg CO2/litre', 'pumping and treatment', APPENDIX_A);

export const WATER_LITRES_PER_DAY = {
  low: f(100, 'litres/day', 'bucket bath', APPENDIX_A),
  medium: f(180, 'litres/day', 'short shower', APPENDIX_A),
  high: f(300, 'litres/day', 'long shower or tub', APPENDIX_A),
} as const satisfies Record<Level3, Factor>;

/** The daily bath question. Baseline uses WATER_LITRES_PER_DAY instead. */
export const BATH_LITRES = {
  bucket: f(40, 'litres', 'bucket bath', APPENDIX_A),
  short_shower: f(70, 'litres', 'short shower', APPENDIX_A),
  long_shower: f(150, 'litres', 'long shower or tub', APPENDIX_A),
} as const satisfies Record<BathChoice, Factor>;

/** Added to a daily bath choice; already inside the baseline level figures. */
export const OTHER_HOUSEHOLD_LITRES_PER_DAY = f(
  80,
  'litres/day',
  'cooking, cleaning, flushing',
  APPENDIX_A,
);

// ---------------------------------------------------------------------------
// Waste
// ---------------------------------------------------------------------------

export const WASTE_KG_CO2_PER_KG = f(
  0.5,
  'kg CO2e/kg',
  'landfill methane from municipal solid waste',
  APPENDIX_A,
);

export const MSW_KG_PER_PERSON_DAY = f(
  0.45,
  'kg/person/day',
  'Indian urban per-capita municipal solid waste',
  APPENDIX_A,
);

export const WASTE_HABIT_MULTIPLIER = {
  segregate_and_compost: f(0.35, 'multiplier', 'wet waste diverted from landfill', APPENDIX_A),
  segregate_only: f(0.7, 'multiplier', 'dry recyclables diverted', APPENDIX_A),
  none: f(1.0, 'multiplier', 'everything to landfill', APPENDIX_A),
} as const satisfies Record<WasteHabit, Factor>;

/** The daily waste question: start at 1.00, subtract per action, floor at 0.30. */
export const WASTE_ACTION_DELTA = {
  segregated: f(-0.3, 'multiplier delta', 'wet and dry separated', APPENDIX_A),
  composted: f(-0.35, 'multiplier delta', 'wet waste composted', APPENDIX_A),
  refused_plastic: f(-0.05, 'multiplier delta', 'single-use plastic refused', APPENDIX_A),
} as const satisfies Record<string, Factor>;

export const WASTE_MULTIPLIER_FLOOR = 0.3;
