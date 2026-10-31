import {
  type BaselineProfile,
  clampDailyKg,
  computeDailyBaseline,
  type DailyBaseline,
} from '@common/carbon/calculate.ts';
import { FACTOR_VERSION } from '@common/carbon/factors.ts';
import {
  type CategorySources,
  dailyFootprints,
  dailyLogs,
  goals,
  lifestyleProfiles,
  type Trip,
  users,
} from '@database/schema/index.ts';
import type { RegionRow } from './regions.seed.ts';
import {
  between,
  insertAll,
  intBetween,
  istDate,
  istMoment,
  pick,
  type RewardRow,
  rng,
  round2,
  type Tx,
} from './support.ts';

/** PRD-v2 §6.2: the Home chart shows 60 days. */
const DAYS = 60;

/** PRD-v2 §4.2. Reward amounts, not emission factors — they do not belong in factors.ts. */
const AWARD = {
  onboarding: { points: 100, coins: 50 },
  dailyLog: { points: 10, coins: 5 },
  streak7: { points: 50, coins: 25 },
  streak30: { points: 250, coins: 100 },
} as const;

/** PRD-v2 §6.4: a goal's target is frozen at creation over this many days. */
const DAYS_IN_PERIOD = { week: 7, month: 30, quarter: 90 } as const;
const GOAL_POINTS = { week: 100, month: 250, quarter: 500 } as const;

type Trend = 'improving' | 'flat' | 'worsening' | 'erratic';

/** The 12 answers an archetype fixes. Household size and kWh are varied per user. */
type Archetype = Omit<
  BaselineProfile,
  'householdSize' | 'electricityKwhMonth' | 'kwhSource' | 'commuteDistanceKm' | 'flightsPerYear'
> & { commuteDistanceKm: number; flightsPerYear: number };

/**
 * Ten lifestyles rather than 25 hand-written profiles: the archetype fixes the
 * answers that hang together (an EV driver has solar and an induction hob), and
 * the per-user jitter below varies household size, commute distance, flights
 * and electricity. That produces real variety without 400 lines of literals
 * nobody will read.
 */
const ARCHETYPES = {
  car_commuter: {
    coolingUsage: 'ac_daily',
    dietType: 'non_veg_daily',
    foodWasteLevel: 'medium',
    packagedFoodFreq: 'often',
    primaryCommuteMode: 'car',
    vehicleFuel: 'petrol',
    commuteDistanceKm: 18,
    flightsPerYear: 3,
    cookingFuel: 'lpg',
    hasSolar: false,
    waterUsageLevel: 'high',
    wasteHabit: 'none',
  },
  metro_rider: {
    coolingUsage: 'ac_occasional',
    dietType: 'vegetarian',
    foodWasteLevel: 'low',
    packagedFoodFreq: 'sometimes',
    primaryCommuteMode: 'metro_train',
    vehicleFuel: 'not_applicable',
    commuteDistanceKm: 14,
    flightsPerYear: 1,
    cookingFuel: 'png',
    hasSolar: false,
    waterUsageLevel: 'medium',
    wasteHabit: 'segregate_only',
  },
  work_from_home: {
    coolingUsage: 'fan_only',
    dietType: 'vegan',
    foodWasteLevel: 'low',
    packagedFoodFreq: 'rarely',
    primaryCommuteMode: 'work_from_home',
    vehicleFuel: 'not_applicable',
    commuteDistanceKm: 0,
    flightsPerYear: 0,
    cookingFuel: 'electric_induction',
    hasSolar: true,
    waterUsageLevel: 'low',
    wasteHabit: 'segregate_and_compost',
  },
  two_wheeler: {
    coolingUsage: 'ac_occasional',
    dietType: 'eggetarian',
    foodWasteLevel: 'medium',
    packagedFoodFreq: 'sometimes',
    primaryCommuteMode: 'two_wheeler',
    vehicleFuel: 'petrol',
    commuteDistanceKm: 11,
    flightsPerYear: 0,
    cookingFuel: 'lpg',
    hasSolar: false,
    waterUsageLevel: 'medium',
    wasteHabit: 'segregate_only',
  },
  bus_rider: {
    coolingUsage: 'fan_only',
    dietType: 'non_veg_weekly',
    foodWasteLevel: 'high',
    packagedFoodFreq: 'sometimes',
    primaryCommuteMode: 'bus',
    vehicleFuel: 'not_applicable',
    commuteDistanceKm: 9,
    flightsPerYear: 0,
    cookingFuel: 'lpg',
    hasSolar: false,
    waterUsageLevel: 'low',
    wasteHabit: 'none',
  },
  cyclist: {
    coolingUsage: 'none',
    dietType: 'vegetarian',
    foodWasteLevel: 'low',
    packagedFoodFreq: 'rarely',
    primaryCommuteMode: 'cycle',
    vehicleFuel: 'not_applicable',
    commuteDistanceKm: 6,
    flightsPerYear: 0,
    cookingFuel: 'png',
    hasSolar: false,
    waterUsageLevel: 'low',
    wasteHabit: 'segregate_and_compost',
  },
  cab_flyer: {
    coolingUsage: 'ac_daily',
    dietType: 'non_veg_daily',
    foodWasteLevel: 'high',
    packagedFoodFreq: 'often',
    primaryCommuteMode: 'cab',
    vehicleFuel: 'not_applicable',
    commuteDistanceKm: 22,
    flightsPerYear: 8,
    cookingFuel: 'electric_induction',
    hasSolar: false,
    waterUsageLevel: 'high',
    wasteHabit: 'none',
  },
  auto_rider: {
    coolingUsage: 'ac_occasional',
    dietType: 'non_veg_weekly',
    foodWasteLevel: 'medium',
    packagedFoodFreq: 'sometimes',
    primaryCommuteMode: 'auto_rickshaw',
    vehicleFuel: 'not_applicable',
    commuteDistanceKm: 7,
    flightsPerYear: 1,
    cookingFuel: 'lpg',
    hasSolar: false,
    waterUsageLevel: 'medium',
    wasteHabit: 'segregate_only',
  },
  ev_driver: {
    coolingUsage: 'ac_daily',
    dietType: 'vegetarian',
    foodWasteLevel: 'low',
    packagedFoodFreq: 'sometimes',
    primaryCommuteMode: 'car',
    vehicleFuel: 'electric',
    commuteDistanceKm: 16,
    flightsPerYear: 2,
    cookingFuel: 'electric_induction',
    hasSolar: true,
    waterUsageLevel: 'medium',
    wasteHabit: 'segregate_and_compost',
  },
  firewood_household: {
    coolingUsage: 'none',
    dietType: 'vegetarian',
    foodWasteLevel: 'medium',
    packagedFoodFreq: 'rarely',
    primaryCommuteMode: 'bus',
    vehicleFuel: 'not_applicable',
    commuteDistanceKm: 5,
    flightsPerYear: 0,
    cookingFuel: 'firewood',
    hasSolar: false,
    waterUsageLevel: 'low',
    wasteHabit: 'segregate_only',
  },
} as const satisfies Record<string, Archetype>;

type SeedUser = {
  name: string;
  /** Inserted lowercase: uniqueness is a unique index on lower(email). */
  email: string;
  city: string;
  regionCode: string;
  archetype: keyof typeof ARCHETYPES;
  admin?: true;
  /** Unverified accounts have earned nothing — §4.4 gates every reward on it. */
  unverified?: true;
  /** Below 5, onboarding is unfinished: no baseline, no footprints, no tabs. */
  steps?: number;
  trend: Trend;
  streak: number;
  /** Share of the 60 days this user bothered to log. */
  logRate: number;
  /**
   * Days ago to drive to a near-zero day, tripping MIN_PLAUSIBLE_KG.
   *
   * No baseline-derived day can fall under 1.5 kg on its own — the diet floor
   * alone is 2.89 — so without forcing one, the clamped flag and the UI that
   * labels a floored day would have no row to render in the dev world.
   */
  implausibleDayAgo?: number;
};

/**
 * 25 accounts, chosen so every screen has something real to render: the
 * leaderboard has a spread, Home has improving and worsening trends, and the
 * two states that break a naive UI — a half-finished onboarding and a verified
 * account with zero points — both exist.
 */
const SEED_USERS: readonly SeedUser[] = [
  {
    name: 'Dev Admin',
    email: 'dev@ecolife.app',
    city: 'Mumbai',
    regionCode: 'IN-MH',
    archetype: 'car_commuter',
    admin: true,
    trend: 'improving',
    streak: 12,
    logRate: 0.85,
  },
  {
    name: 'Aarav Sharma',
    email: 'aarav.sharma@ecolife.app',
    city: 'Pune',
    regionCode: 'IN-MH',
    archetype: 'metro_rider',
    trend: 'improving',
    streak: 31,
    logRate: 0.95,
  },
  {
    name: 'Isha Verma',
    email: 'isha.verma@ecolife.app',
    city: 'Bengaluru',
    regionCode: 'IN-KA',
    archetype: 'work_from_home',
    trend: 'flat',
    streak: 7,
    logRate: 0.8,
  },
  {
    name: 'Rohan Mehta',
    email: 'rohan.mehta@ecolife.app',
    city: 'Delhi',
    regionCode: 'IN-DL',
    archetype: 'car_commuter',
    trend: 'worsening',
    streak: 0,
    logRate: 0.5,
  },
  {
    name: 'Ananya Iyer',
    email: 'ananya.iyer@ecolife.app',
    city: 'Chennai',
    regionCode: 'IN-TN',
    archetype: 'two_wheeler',
    trend: 'improving',
    streak: 5,
    logRate: 0.75,
  },
  {
    name: 'Kabir Singh',
    email: 'kabir.singh@ecolife.app',
    city: 'Gurugram',
    regionCode: 'IN-HR',
    archetype: 'cab_flyer',
    trend: 'worsening',
    streak: 2,
    logRate: 0.6,
  },
  {
    name: 'Meera Nair',
    email: 'meera.nair@ecolife.app',
    city: 'Kochi',
    regionCode: 'IN-KL',
    archetype: 'cyclist',
    trend: 'improving',
    streak: 21,
    logRate: 0.9,
  },
  {
    name: 'Arjun Rao',
    email: 'arjun.rao@ecolife.app',
    city: 'Hyderabad',
    regionCode: 'IN-TG',
    archetype: 'bus_rider',
    trend: 'flat',
    streak: 9,
    logRate: 0.7,
  },
  {
    name: 'Diya Kapoor',
    email: 'diya.kapoor@ecolife.app',
    city: 'Jaipur',
    regionCode: 'IN-RJ',
    archetype: 'auto_rider',
    trend: 'erratic',
    streak: 3,
    logRate: 0.65,
    implausibleDayAgo: 3,
  },
  {
    name: 'Vivaan Patel',
    email: 'vivaan.patel@ecolife.app',
    city: 'Ahmedabad',
    regionCode: 'IN-GJ',
    archetype: 'ev_driver',
    trend: 'improving',
    streak: 14,
    logRate: 0.85,
  },
  {
    name: 'Saanvi Joshi',
    email: 'saanvi.joshi@ecolife.app',
    city: 'Nagpur',
    regionCode: 'IN-MH',
    archetype: 'firewood_household',
    trend: 'flat',
    streak: 1,
    logRate: 0.55,
  },
  {
    name: 'Advait Bose',
    email: 'advait.bose@ecolife.app',
    city: 'Kolkata',
    regionCode: 'IN-WB',
    archetype: 'metro_rider',
    trend: 'improving',
    streak: 18,
    logRate: 0.88,
  },
  {
    name: 'Kiara Menon',
    email: 'kiara.menon@ecolife.app',
    city: 'Coimbatore',
    regionCode: 'IN-TN',
    archetype: 'two_wheeler',
    trend: 'worsening',
    streak: 4,
    logRate: 0.6,
  },
  {
    name: 'Reyansh Gupta',
    email: 'reyansh.gupta@ecolife.app',
    city: 'Lucknow',
    regionCode: 'IN-UP',
    archetype: 'car_commuter',
    trend: 'erratic',
    streak: 6,
    logRate: 0.7,
  },
  {
    name: 'Aadhya Reddy',
    email: 'aadhya.reddy@ecolife.app',
    city: 'Visakhapatnam',
    regionCode: 'IN-AP',
    archetype: 'bus_rider',
    trend: 'improving',
    streak: 10,
    logRate: 0.8,
  },
  {
    name: 'Vihaan Chawla',
    email: 'vihaan.chawla@ecolife.app',
    city: 'Chandigarh',
    regionCode: 'IN-CH',
    archetype: 'cyclist',
    trend: 'flat',
    streak: 8,
    logRate: 0.72,
  },
  {
    name: "Myra D'Souza",
    email: 'myra.dsouza@ecolife.app',
    city: 'Panaji',
    regionCode: 'IN-GA',
    archetype: 'auto_rider',
    trend: 'improving',
    streak: 26,
    logRate: 0.92,
  },
  {
    name: 'Ayaan Khan',
    email: 'ayaan.khan@ecolife.app',
    city: 'Bhopal',
    regionCode: 'IN-MP',
    archetype: 'cab_flyer',
    trend: 'worsening',
    streak: 0,
    logRate: 0.45,
  },
  {
    name: 'Pari Desai',
    email: 'pari.desai@ecolife.app',
    city: 'Surat',
    regionCode: 'IN-GJ',
    archetype: 'work_from_home',
    trend: 'improving',
    streak: 16,
    logRate: 0.86,
  },
  {
    name: 'Shaurya Malhotra',
    email: 'shaurya.malhotra@ecolife.app',
    city: 'Noida',
    regionCode: 'IN-UP',
    archetype: 'ev_driver',
    trend: 'flat',
    streak: 11,
    logRate: 0.78,
  },
  {
    name: 'Anika Pillai',
    email: 'anika.pillai@ecolife.app',
    city: 'Thiruvananthapuram',
    regionCode: 'IN-KL',
    archetype: 'cyclist',
    trend: 'improving',
    streak: 23,
    logRate: 0.9,
  },
  {
    name: 'Dhruv Saxena',
    email: 'dhruv.saxena@ecolife.app',
    city: 'Indore',
    regionCode: 'IN-MP',
    archetype: 'two_wheeler',
    trend: 'erratic',
    streak: 2,
    logRate: 0.6,
  },
  {
    name: 'Navya Bhatt',
    email: 'navya.bhatt@ecolife.app',
    city: 'Udaipur',
    regionCode: 'IN-RJ',
    archetype: 'bus_rider',
    trend: 'flat',
    streak: 5,
    logRate: 0.68,
  },
  {
    name: 'Ishaan Ghosh',
    email: 'ishaan.ghosh@ecolife.app',
    city: 'Howrah',
    regionCode: 'IN-WB',
    archetype: 'firewood_household',
    unverified: true,
    trend: 'flat',
    streak: 0,
    logRate: 0.4,
  },
  {
    name: 'Tara Menon',
    email: 'tara.menon@ecolife.app',
    city: 'Mysuru',
    regionCode: 'IN-KA',
    archetype: 'cyclist',
    steps: 2,
    trend: 'flat',
    streak: 0,
    logRate: 0,
  },
];

export type SeededUser = {
  id: number;
  name: string;
  email: string;
  verified: boolean;
  baseline: DailyBaseline | null;
};

export type UserSeedResult = {
  seeded: SeededUser[];
  rewards: RewardRow[];
  counts: { users: number; profiles: number; logs: number; footprints: number; goals: number };
};

/** Where this user sits between their best and worst day, 60 days ago to today. */
function trendAt(trend: Trend, dayIndex: number, r: () => number): number {
  const t = dayIndex / (DAYS - 1);
  switch (trend) {
    case 'improving':
      return 1.1 - 0.3 * t;
    case 'worsening':
      return 0.85 + 0.3 * t;
    case 'flat':
      return 0.98;
    case 'erratic':
      return between(r, 0.75, 1.25);
  }
}

/**
 * Which of the 60 days this user logged.
 *
 * The tail is forced to match `users.current_streak` exactly — the last
 * `streak` days logged, and the day before them not — because a streak counter
 * that disagrees with the logs behind it sends the next person debugging the
 * streak job instead of their own code.
 */
function logDays(streak: number, logRate: number, r: () => number): boolean[] {
  const logged = Array.from({ length: DAYS }, () => r() < logRate);
  for (let i = DAYS - streak; i < DAYS; i++) logged[i] = true;
  const breakAt = DAYS - streak - 1;
  if (breakAt >= 0) logged[breakAt] = false;
  return logged;
}

function longestRun(logged: readonly boolean[]): number {
  let best = 0;
  let run = 0;
  for (const day of logged) {
    run = day ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

const CATEGORIES = ['transport', 'food', 'home_energy', 'water', 'waste'] as const;
type Category = (typeof CATEGORIES)[number];

/** Most logged days answer all five; the rest skip one or two, as people do. */
function answeredCategories(r: () => number): Set<Category> {
  const answered = new Set<Category>(CATEGORIES);
  if (r() < 0.7) return answered;
  for (let i = 0; i < intBetween(r, 1, 2); i++) answered.delete(pick(r, CATEGORIES));
  return answered;
}

function tripsFor(profile: BaselineProfile, r: () => number): Trip[] {
  if (profile.primaryCommuteMode === 'work_from_home') {
    return [{ mode: 'work_from_home', km: 0 }];
  }
  const roundTrip = round2((profile.commuteDistanceKm ?? 0) * 2 * between(r, 0.8, 1.2));
  const trips: Trip[] = [{ mode: profile.primaryCommuteMode ?? 'walk', km: roundTrip }];
  // Roughly one evening in six adds an app-hailed ride. `trips[].mode` is free
  // text inside jsonb, so this is a string the commute_mode enum does not have
  // — and the one a v1-style unhandled switch case silently costed at zero.
  if (r() < 0.17) trips.push({ mode: 'ride_sharing', km: round2(between(r, 3, 14)) });
  return trips;
}

/** Three meals, distributed the way this diet usually eats them. */
function mealsFor(
  diet: BaselineProfile['dietType'],
  r: () => number,
): { vegMeals: number; nonVegMeals: number; veganMeals: number } {
  switch (diet) {
    case 'vegan':
      return { vegMeals: 0, nonVegMeals: 0, veganMeals: 3 };
    case 'vegetarian':
      return r() < 0.3
        ? { vegMeals: 2, nonVegMeals: 0, veganMeals: 1 }
        : { vegMeals: 3, nonVegMeals: 0, veganMeals: 0 };
    case 'eggetarian':
    case 'non_veg_weekly':
      return r() < 0.4
        ? { vegMeals: 2, nonVegMeals: 1, veganMeals: 0 }
        : { vegMeals: 3, nonVegMeals: 0, veganMeals: 0 };
    case 'non_veg_daily':
      return r() < 0.5
        ? { vegMeals: 1, nonVegMeals: 2, veganMeals: 0 }
        : { vegMeals: 2, nonVegMeals: 1, veganMeals: 0 };
    default:
      return { vegMeals: 3, nonVegMeals: 0, veganMeals: 0 };
  }
}

function acBucketFor(cooling: BaselineProfile['coolingUsage'], r: () => number) {
  switch (cooling) {
    case 'ac_daily':
      return pick(r, ['1_3', '4_8', '8_plus'] as const);
    case 'ac_occasional':
      return pick(r, ['0', '1_3', '4_8'] as const);
    default:
      // Q3 is not shown at all when cooling_usage is none or fan_only, so zero
      // hours is the answer rather than a skipped question.
      return '0' as const;
  }
}

function bathFor(level: BaselineProfile['waterUsageLevel'], r: () => number) {
  switch (level) {
    case 'high':
      return pick(r, ['long_shower', 'long_shower', 'short_shower'] as const);
    case 'medium':
      return pick(r, ['short_shower', 'short_shower', 'bucket'] as const);
    default:
      return pick(r, ['bucket', 'bucket', 'short_shower'] as const);
  }
}

function wasteActionsFor(habit: BaselineProfile['wasteHabit'], r: () => number): string[] {
  const actions =
    habit === 'segregate_and_compost'
      ? ['segregated', 'composted']
      : habit === 'segregate_only'
        ? ['segregated']
        : [];
  if (r() < 0.35) actions.push('refused_plastic');
  return actions.length > 0 ? actions : ['none_of_these'];
}

/** Everything about one seeded person, resolved before anything is written. */
type Plan = {
  user: SeedUser;
  profile: BaselineProfile;
  billInr: number | null;
  steps: number;
  verified: boolean;
  baseline: DailyBaseline | null;
  logged: boolean[];
  longestStreak: number;
};

/**
 * The answers and the 60-day plan for every user.
 *
 * Done in full before the first INSERT so `users` can be written once, with
 * its streak columns already correct, instead of being UPDATEd 25 times.
 */
function planUsers(regions: Map<string, RegionRow>): Plan[] {
  const r = rng(20261031);

  return SEED_USERS.map((user) => {
    const region = regions.get(user.regionCode) ?? null;
    const archetype = ARCHETYPES[user.archetype];
    const steps = user.steps ?? 5;
    const onboarded = steps === 5;

    const householdSize = intBetween(r, 1, 6);
    // One user in three does not know their kWh, which is the whole reason the
    // Appendix A estimator exists. Of those who do, half read it off a bill.
    const knowsKwh = r() < 0.67;
    const fromBill = knowsKwh && r() < 0.5;
    const kwhMonth = knowsKwh ? Math.round(between(r, 90, 520)) : null;

    const profile: BaselineProfile = {
      householdSize,
      coolingUsage: archetype.coolingUsage,
      dietType: archetype.dietType,
      foodWasteLevel: archetype.foodWasteLevel,
      packagedFoodFreq: archetype.packagedFoodFreq,
      primaryCommuteMode: onboarded ? archetype.primaryCommuteMode : null,
      vehicleFuel: onboarded ? archetype.vehicleFuel : null,
      commuteDistanceKm: onboarded
        ? round2(archetype.commuteDistanceKm * between(r, 0.6, 1.5))
        : null,
      flightsPerYear: onboarded
        ? Math.max(0, archetype.flightsPerYear + intBetween(r, -1, 2))
        : null,
      electricityKwhMonth: onboarded ? kwhMonth : null,
      kwhSource: onboarded && knowsKwh ? (fromBill ? 'from_bill' : 'reported') : null,
      cookingFuel: onboarded ? archetype.cookingFuel : null,
      hasSolar: onboarded ? archetype.hasSolar : null,
      waterUsageLevel: onboarded ? archetype.waterUsageLevel : null,
      wasteHabit: onboarded ? archetype.wasteHabit : null,
    };

    const baseline = onboarded ? computeDailyBaseline(profile, region) : null;
    const logged = baseline ? logDays(user.streak, user.logRate, r) : [];

    return {
      user,
      profile,
      // What the user actually typed, back-converted at their regional tariff.
      billInr:
        fromBill && onboarded && kwhMonth !== null && region
          ? Math.round((kwhMonth * region.tariffPaisePerKwh) / 100)
          : null,
      steps,
      verified: !user.unverified,
      baseline,
      logged,
      longestStreak: Math.max(user.streak, longestRun(logged)),
    };
  });
}

/**
 * Users, profiles with computed baselines, 60 days of logs and footprints, four
 * goals, and the ledger rows that justify every point any of them holds.
 *
 * The ledger is returned rather than written here: `seed.ts` inserts it in one
 * go and then derives `users.points_total` from it with a single UPDATE, so the
 * denormalised cache cannot disagree with the ledger by construction.
 */
export async function seedUsers(
  tx: Tx,
  regions: Map<string, RegionRow>,
  passwordHash: string,
): Promise<UserSeedResult> {
  const r = rng(99001);
  const plans = planUsers(regions);

  const inserted = await tx
    .insert(users)
    .values(
      plans.map((p) => ({
        name: p.user.name,
        email: p.user.email.toLowerCase(),
        passwordHash,
        role: p.user.admin ? ('admin' as const) : ('user' as const),
        emailVerifiedAt: p.verified ? istMoment(DAYS + 5, 10) : null,
        city: p.user.city,
        regionCode: p.user.regionCode,
        timezone: 'Asia/Kolkata',
        currentStreak: p.baseline ? p.user.streak : 0,
        longestStreak: p.baseline ? p.longestStreak : 0,
        onboardedAt: p.steps === 5 ? istMoment(DAYS, 9) : null,
      })),
    )
    .returning({ id: users.id });

  if (inserted.length !== plans.length) throw new Error('user insert returned the wrong row count');

  const seeded: SeededUser[] = [];
  const profileRows: (typeof lifestyleProfiles.$inferInsert)[] = [];
  const logRows: (typeof dailyLogs.$inferInsert)[] = [];
  const footprintRows: (typeof dailyFootprints.$inferInsert)[] = [];
  const rewards: RewardRow[] = [];

  for (const [index, plan] of plans.entries()) {
    const userId = inserted[index]?.id;
    if (userId === undefined) throw new Error(`no id for seeded user ${plan.user.email}`);

    const { profile, baseline, verified } = plan;
    seeded.push({ id: userId, name: plan.user.name, email: plan.user.email, verified, baseline });

    profileRows.push({
      userId,
      ...profile,
      city: plan.user.city,
      regionCode: plan.user.regionCode,
      electricityBillInr: plan.billInr,
      // §3.2 stores the resolved value AND which path produced it. The engine
      // is the thing that resolved it, so its answer is the one recorded —
      // 'estimated' for the third of users who do not know their kWh.
      kwhSource: baseline?.kwhSource ?? profile.kwhSource,
      completedSteps: plan.steps,
      factorVersion: FACTOR_VERSION,
      baselineTransportKg: baseline?.baselineTransportKg ?? null,
      baselineFoodKg: baseline?.baselineFoodKg ?? null,
      baselineHomeEnergyKg: baseline?.baselineHomeEnergyKg ?? null,
      baselineWaterKg: baseline?.baselineWaterKg ?? null,
      baselineWasteKg: baseline?.baselineWasteKg ?? null,
      baselineTotalKg: baseline?.baselineTotalKg ?? null,
      baselineFlightKg: baseline?.baselineFlightKg ?? null,
      baselineCookKg: baseline?.baselineCookKg ?? null,
      baselineGridBaseKg: baseline?.baselineGridBaseKg ?? null,
    });

    // Onboarding has not finished, so there is no baseline to vary and nothing
    // to show on Home. This is the state every tab must redirect out of.
    if (!baseline) continue;

    if (verified) {
      rewards.push({
        userId,
        pointsDelta: AWARD.onboarding.points,
        coinsDelta: AWARD.onboarding.coins,
        source: 'onboarding',
        sourceId: `onboarding:${userId}`,
        createdAt: istMoment(DAYS, 9),
      });
    }

    for (let i = 0; i < DAYS; i++) {
      const daysAgo = DAYS - 1 - i;
      const logDate = istDate(daysAgo);
      const trend = trendAt(plan.user.trend, i, r);
      // A day the user barely moved, ate once and went to bed: the clamp's
      // whole reason to exist (§4.4), and the only way a seeded day gets under
      // MIN_PLAUSIBLE_KG.
      const scale = plan.user.implausibleDayAgo === daysAgo ? 0.05 : 1;
      const jitter = () => trend * between(r, 0.85, 1.15) * scale;

      // The flight component never varies day to day, which is exactly why it
      // is stored on the profile rather than recomputed from a daily log.
      const commuteOnly = baseline.baselineTransportKg - baseline.baselineFlightKg;
      const transportKg = commuteOnly * jitter() + baseline.baselineFlightKg * scale;
      const foodKg = baseline.baselineFoodKg * jitter();
      const homeEnergyKg = baseline.baselineHomeEnergyKg * jitter();
      const waterKg = baseline.baselineWaterKg * jitter();
      const wasteKg = baseline.baselineWasteKg * jitter();
      const { totalKg, clamped } = clampDailyKg(
        transportKg + foodKg + homeEnergyKg + waterKg + wasteKg,
      );

      const answered = plan.logged[i] ? answeredCategories(r) : new Set<Category>();
      const sources = Object.fromEntries(
        CATEGORIES.map((c) => [c, answered.has(c) ? 'logged' : 'inferred']),
      ) as CategorySources;

      if (plan.logged[i]) {
        const meals = mealsFor(profile.dietType, r);
        const food = answered.has('food');
        logRows.push({
          userId,
          logDate,
          clientLogId: crypto.randomUUID(),
          trips: answered.has('transport') ? tripsFor(profile, r) : null,
          vegMeals: food ? meals.vegMeals : null,
          nonVegMeals: food ? meals.nonVegMeals : null,
          veganMeals: food ? meals.veganMeals : null,
          acHoursBucket: answered.has('home_energy') ? acBucketFor(profile.coolingUsage, r) : null,
          bathChoice: answered.has('water') ? bathFor(profile.waterUsageLevel, r) : null,
          wasteActions: answered.has('waste') ? wasteActionsFor(profile.wasteHabit, r) : null,
          answeredCount: answered.size,
          submittedAt: istMoment(daysAgo, 21),
        });
      }

      footprintRows.push({
        userId,
        logDate,
        transportKg,
        foodKg,
        homeEnergyKg,
        waterKg,
        wasteKg,
        totalKg,
        baselineTotalKg: baseline.baselineTotalKg,
        reductionPct: ((baseline.baselineTotalKg - totalKg) / baseline.baselineTotalKg) * 100,
        sources,
        clamped,
        factorVersion: FACTOR_VERSION,
        createdAt: istMoment(daysAgo, 22),
        updatedAt: istMoment(daysAgo, 22),
      });
    }

    // Streak bonuses, one per completed cycle: §4.2 keys them by cycle index
    // precisely so the 7-day bonus can be earned more than once.
    if (verified) {
      for (const [length, award] of [
        [7, AWARD.streak7],
        [30, AWARD.streak30],
      ] as const) {
        for (let cycle = 0; cycle < Math.floor(plan.longestStreak / length); cycle++) {
          rewards.push({
            userId,
            pointsDelta: award.points,
            coinsDelta: award.coins,
            source: 'streak',
            sourceId: `streak:${userId}:${length}:${cycle}`,
            createdAt: istMoment(Math.max(1, DAYS - length * (cycle + 1)), 23),
          });
        }
      }
    }
  }

  await insertAll(profileRows, (batch) => tx.insert(lifestyleProfiles).values(batch));

  // Logs go in first so every footprint can point at the log that produced it.
  const logIds = new Map<string, number>();
  await insertAll(logRows, async (batch) => {
    const written = await tx
      .insert(dailyLogs)
      .values(batch)
      .returning({ id: dailyLogs.id, userId: dailyLogs.userId, logDate: dailyLogs.logDate });
    for (const row of written) logIds.set(`${row.userId}:${row.logDate}`, row.id);
  });

  await insertAll(
    footprintRows.map((row) => ({
      ...row,
      dailyLogId: logIds.get(`${row.userId}:${row.logDate}`) ?? null,
    })),
    (batch) => tx.insert(dailyFootprints).values(batch),
  );

  rewards.push(...logAwards(seeded, logRows, footprintRows, logIds));

  const goalResult = await seedGoals(tx, seeded);
  rewards.push(...goalResult.rewards);
  rewards.push(...adjustments(seeded, rewards));

  return {
    seeded,
    rewards,
    counts: {
      users: plans.length,
      profiles: profileRows.length,
      logs: logRows.length,
      footprints: footprintRows.length,
      goals: goalResult.count,
    },
  };
}

/**
 * One `daily_log` award per logged day, plus the reduction bonus.
 *
 * The bonus is `round(min(reductionPct, 50) / 2)` points and half as many
 * coins (§4.2), and §4.4 refuses to pay it unless all five questions were
 * answered — otherwise logging one cheap answer and skipping the rest is the
 * cheapest way to farm points.
 */
function logAwards(
  seeded: readonly SeededUser[],
  logs: ReadonlyArray<typeof dailyLogs.$inferInsert>,
  footprints: ReadonlyArray<typeof dailyFootprints.$inferInsert>,
  logIds: Map<string, number>,
): RewardRow[] {
  const verified = new Set(seeded.filter((s) => s.verified).map((s) => s.id));
  const fullyAnswered = new Set(
    logs.filter((l) => l.answeredCount === 5).map((l) => `${l.userId}:${l.logDate}`),
  );
  const reductionByKey = new Map(
    footprints.map((fp) => [`${fp.userId}:${fp.logDate}`, fp.reductionPct ?? 0]),
  );
  const rows: RewardRow[] = [];

  for (const [key, logId] of logIds) {
    const log = logs.find((l) => `${l.userId}:${l.logDate}` === key);
    if (!log || !verified.has(log.userId)) continue;

    rows.push({
      userId: log.userId,
      pointsDelta: AWARD.dailyLog.points,
      coinsDelta: AWARD.dailyLog.coins,
      source: 'daily_log',
      sourceId: `daily_log:${logId}`,
      createdAt: log.submittedAt instanceof Date ? log.submittedAt : undefined,
    });

    if (!fullyAnswered.has(key)) continue;
    const points = Math.round(Math.min(reductionByKey.get(key) ?? 0, 50) / 2);
    if (points <= 0) continue;
    rows.push({
      userId: log.userId,
      pointsDelta: points,
      coinsDelta: Math.round(points / 2),
      source: 'reduction',
      sourceId: `reduction:${logId}`,
      createdAt: log.submittedAt instanceof Date ? log.submittedAt : undefined,
    });
  }
  return rows;
}

/**
 * Four goals across four users: two running (one on track, one not) and two
 * settled (achieved and missed).
 *
 * `one_active_goal_per_user` is a partial unique index, so the two active goals
 * have to belong to different people — that is the constraint doing its job.
 * Every `targetKgTotal` is frozen here at creation from the baseline snapshot,
 * which is the v1 fix: deriving it from the running total made percentage goals
 * mathematically unachievable (§6.4).
 */
async function seedGoals(
  tx: Tx,
  seeded: readonly SeededUser[],
): Promise<{ count: number; rewards: RewardRow[] }> {
  const by = (email: string) => {
    const user = seeded.find((s) => s.email === email);
    if (!user?.baseline) throw new Error(`goal target ${email} has no baseline`);
    return { id: user.id, baseline: user.baseline.baselineTotalKg };
  };

  const onTrack = by('aarav.sharma@ecolife.app');
  const offTrack = by('kabir.singh@ecolife.app');
  const achieved = by('meera.nair@ecolife.app');
  const missed = by('rohan.mehta@ecolife.app');

  const cap = round2(offTrack.baseline * 0.55);
  const achievedTarget = achieved.baseline * DAYS_IN_PERIOD.week * 0.8;
  const missedTarget = missed.baseline * DAYS_IN_PERIOD.month * 0.9;

  const rows: (typeof goals.$inferInsert)[] = [
    {
      // An improving user against a 15% cut: on track, with a projection that
      // lands under target.
      userId: onTrack.id,
      type: 'reduce_percent',
      period: 'month',
      reducePercent: 15,
      startDate: istDate(10),
      endDate: istDate(-20),
      baselineKgTotal: onTrack.baseline * DAYS_IN_PERIOD.month,
      targetKgTotal: onTrack.baseline * DAYS_IN_PERIOD.month * 0.85,
      status: 'active',
      createdAt: istMoment(10, 8),
    },
    {
      // A cap at 55% of baseline for someone whose footprint is rising: this
      // one is meant to miss, so "you are off track" has data behind it.
      userId: offTrack.id,
      type: 'absolute_cap',
      period: 'week',
      capKgPerDay: cap,
      startDate: istDate(3),
      endDate: istDate(-4),
      baselineKgTotal: offTrack.baseline * DAYS_IN_PERIOD.week,
      targetKgTotal: cap * DAYS_IN_PERIOD.week,
      status: 'active',
      createdAt: istMoment(3, 8),
    },
    {
      userId: achieved.id,
      type: 'reduce_percent',
      period: 'week',
      reducePercent: 20,
      startDate: istDate(17),
      endDate: istDate(10),
      baselineKgTotal: achieved.baseline * DAYS_IN_PERIOD.week,
      targetKgTotal: achievedTarget,
      status: 'achieved',
      actualKgTotal: achievedTarget * 0.93,
      settledAt: istMoment(9, 1),
      createdAt: istMoment(17, 8),
    },
    {
      userId: missed.id,
      type: 'reduce_percent',
      period: 'month',
      reducePercent: 10,
      startDate: istDate(45),
      endDate: istDate(15),
      baselineKgTotal: missed.baseline * DAYS_IN_PERIOD.month,
      targetKgTotal: missedTarget,
      status: 'missed',
      actualKgTotal: missedTarget * 1.22,
      settledAt: istMoment(14, 1),
      createdAt: istMoment(45, 8),
    },
  ];

  const written = await tx
    .insert(goals)
    .values(rows)
    .returning({ id: goals.id, userId: goals.userId, status: goals.status, period: goals.period });

  const rewards: RewardRow[] = written
    .filter((g) => g.status === 'achieved')
    .map((g) => ({
      userId: g.userId,
      pointsDelta: GOAL_POINTS[g.period],
      coinsDelta: Math.round(GOAL_POINTS[g.period] / 2),
      source: 'goal' as const,
      sourceId: `goal:${g.id}`,
      note: 'weekly reduction goal achieved',
      createdAt: istMoment(9, 1),
    }));

  return { count: written.length, rewards };
}

/**
 * Coins are spendable and points are not (§4.1), so a world where every wallet
 * is exactly half the points total never exercises the difference that
 * distinction exists for.
 *
 * These spends are booked as admin adjustments rather than `order:` rows,
 * because an order id pointing at no order is a lie the marketplace UI would
 * follow. The spend is capped at 40% of the wallet so `users_coins_non_negative`
 * is never the thing that tells us the arithmetic was wrong.
 */
function adjustments(seeded: readonly SeededUser[], existing: readonly RewardRow[]): RewardRow[] {
  const rows: RewardRow[] = [];

  for (const email of [
    'meera.nair@ecolife.app',
    'advait.bose@ecolife.app',
    'pari.desai@ecolife.app',
  ]) {
    const user = seeded.find((s) => s.email === email);
    if (!user?.verified) continue;
    const wallet = existing
      .filter((row) => row.userId === user.id)
      .reduce((sum, row) => sum + (row.coinsDelta ?? 0), 0);
    const spend = Math.floor(wallet * 0.4);
    if (spend <= 0) continue;
    rows.push({
      userId: user.id,
      pointsDelta: 0,
      coinsDelta: -spend,
      source: 'admin',
      sourceId: `admin:seed-spend-${user.id}`,
      note: 'seeded coin spend, so a wallet is not simply half the points total',
      createdAt: istMoment(4, 12),
    });
  }

  const bonus = seeded.find((s) => s.email === 'ananya.iyer@ecolife.app');
  if (bonus?.verified) {
    rows.push({
      userId: bonus.id,
      pointsDelta: 150,
      coinsDelta: 75,
      source: 'admin',
      sourceId: `admin:seed-bonus-${bonus.id}`,
      note: 'seeded admin adjustment, so the admin console has one to show',
      createdAt: istMoment(6, 12),
    });
  }

  return rows;
}
