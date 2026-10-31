import { describe, expect, it } from 'bun:test';
import {
  type BaselineProfile,
  clampDailyKg,
  commuteFactorKgPerKm,
  computeDailyBaseline,
  estimateKwhMonth,
} from './calculate.ts';
import type { CookingFuel, DietType, Level3, VehicleFuel, WasteHabit } from './factors.ts';

/**
 * Every expected value is written out as arithmetic over the literals in
 * PRD-v2 Appendix A — never read back from factors.ts, and never a snapshot.
 *
 * That is the whole point of this file: a test that imports the factor it is
 * checking passes no matter what the factor becomes. Editing a number in
 * Appendix A must break these assertions, because changing a factor is
 * supposed to be a deliberate act with a version bump behind it (§3.6).
 */

const WEEKDAYS = 5 / 7;
const INDIA_GRID = 0.71;

/** No answer given to anything. Each test fills in only the fields it is about. */
const profile = (over: Partial<BaselineProfile> = {}): BaselineProfile => ({
  householdSize: null,
  coolingUsage: null,
  dietType: null,
  foodWasteLevel: null,
  packagedFoodFreq: null,
  primaryCommuteMode: null,
  vehicleFuel: null,
  commuteDistanceKm: null,
  flightsPerYear: null,
  electricityKwhMonth: null,
  kwhSource: null,
  cookingFuel: null,
  hasSolar: null,
  waterUsageLevel: null,
  wasteHabit: null,
  ...over,
});

describe('transport — commute', () => {
  // [mode, fuel, kg CO2e/km from Appendix A]
  const modes: ReadonlyArray<[BaselineProfile['primaryCommuteMode'], VehicleFuel | null, number]> =
    [
      ['walk', null, 0],
      ['cycle', null, 0],
      ['work_from_home', null, 0],
      ['bus', null, 0.027],
      ['metro_train', null, 0.014],
      ['auto_rickshaw', null, 0.065],
      ['two_wheeler', 'petrol', 0.051],
      ['car', 'petrol', 0.171],
      ['car', 'diesel', 0.15],
      ['car', 'cng', 0.12],
      ['car', 'electric', 0.107],
      ['cab', null, 0.222],
    ];

  for (const [mode, fuel, kgPerKm] of modes) {
    it(`${mode}${fuel ? ` (${fuel})` : ''} over 10 km each way`, () => {
      const b = computeDailyBaseline(
        profile({ primaryCommuteMode: mode, vehicleFuel: fuel, commuteDistanceKm: 10 }),
      );
      // 10 km one way, doubled, weekdays only.
      expect(b.baselineTransportKg).toBeCloseTo(10 * 2 * kgPerKm * WEEKDAYS, 10);
    });
  }

  it('two_wheeler falls back to the published petrol factor for any other fuel', () => {
    // Appendix A publishes no electric two-wheeler. Documented gap, not a zero.
    expect(commuteFactorKgPerKm('two_wheeler', 'electric')).toBe(0.051);
  });

  it('a car with no fuel answer is priced as petrol', () => {
    expect(commuteFactorKgPerKm('car', null)).toBe(0.171);
    expect(commuteFactorKgPerKm('car', 'not_applicable')).toBe(0.171);
  });

  it('ride_sharing is NOT zero — it carries the cab deadhead factor', () => {
    // A client sends this through daily_logs.trips[].mode, which is free text.
    // v1 let an unhandled mode fall through to 0, which reads as a good day.
    expect(commuteFactorKgPerKm('ride_sharing', null)).toBe(0.222);
    expect(commuteFactorKgPerKm('ride_sharing', null)).not.toBe(0);
  });

  it('work_from_home is zero however far away the office is', () => {
    const b = computeDailyBaseline(
      profile({ primaryCommuteMode: 'work_from_home', commuteDistanceKm: 42 }),
    );
    expect(b.baselineTransportKg).toBe(0);
  });

  it('an unknown mode throws instead of silently costing nothing', () => {
    expect(() => commuteFactorKgPerKm('teleport', null)).toThrow('unknown transport mode');
  });

  it('weights the commute 5/7 — dropping it overstates transport by ~28%', () => {
    const b = computeDailyBaseline(
      profile({ primaryCommuteMode: 'car', vehicleFuel: 'petrol', commuteDistanceKm: 10 }),
    );
    // 20 km x 0.171 = 3.42 kg of driving, spread over a 7-day week = 2.442857…
    expect(b.baselineTransportKg).toBeCloseTo(2.442857142857143, 10);
    expect(b.baselineTransportKg).not.toBeCloseTo(3.42, 2);
  });
});

describe('transport — flights', () => {
  it('amortises annual flights across 365 days', () => {
    const b = computeDailyBaseline(profile({ flightsPerYear: 2 }));
    // 2 trips x 2200 km x 0.154 kg/km / 365 = 1.856438…
    expect(b.baselineFlightKg).toBeCloseTo((2 * 2200 * 0.154) / 365, 10);
    expect(b.baselineFlightKg).toBeCloseTo(1.8564383561643836, 10);
  });

  it('keeps the flight component separate so the daily log can reuse it', () => {
    const b = computeDailyBaseline(
      profile({
        primaryCommuteMode: 'bus',
        commuteDistanceKm: 8,
        flightsPerYear: 1,
      }),
    );
    const commute = 8 * 2 * 0.027 * WEEKDAYS;
    const flights = (1 * 2200 * 0.154) / 365;
    expect(b.baselineFlightKg).toBeCloseTo(flights, 10);
    expect(b.baselineTransportKg).toBeCloseTo(commute + flights, 10);
  });

  it('is zero for someone who does not fly', () => {
    expect(computeDailyBaseline(profile({ flightsPerYear: 0 })).baselineFlightKg).toBe(0);
  });
});

describe('food', () => {
  const diets: ReadonlyArray<[DietType, number]> = [
    ['vegan', 2.89],
    ['vegetarian', 3.81],
    ['eggetarian', 3.91],
    ['non_veg_weekly', 4.67],
    ['non_veg_daily', 7.19],
  ];

  for (const [diet, kgPerDay] of diets) {
    it(`${diet} with no waste and no packaging is the bare diet figure`, () => {
      const b = computeDailyBaseline(
        profile({ dietType: diet, foodWasteLevel: 'low', packagedFoodFreq: 'rarely' }),
      );
      expect(b.baselineFoodKg).toBeCloseTo(kgPerDay, 10);
    });
  }

  it('multiplies by the food-waste level and then adds packaging', () => {
    const b = computeDailyBaseline(
      profile({ dietType: 'vegetarian', foodWasteLevel: 'medium', packagedFoodFreq: 'sometimes' }),
    );
    // 3.81 x 1.08 + 0.30 = 4.4148 — the multiplier applies to the diet, the
    // adder does not get multiplied.
    expect(b.baselineFoodKg).toBeCloseTo(3.81 * 1.08 + 0.3, 10);
    expect(b.baselineFoodKg).toBeCloseTo(4.4148, 10);
  });

  it('applies the high multiplier and the often adder', () => {
    const b = computeDailyBaseline(
      profile({ dietType: 'vegetarian', foodWasteLevel: 'high', packagedFoodFreq: 'often' }),
    );
    expect(b.baselineFoodKg).toBeCloseTo(3.81 * 1.18 + 0.7, 10);
  });
});

describe('home energy — electricity', () => {
  it('estimates monthly kWh when the user does not know it, and says so', () => {
    const b = computeDailyBaseline(profile({ householdSize: 3, coolingUsage: 'ac_daily' }), {
      gridKgPerKwh: INDIA_GRID,
    });
    // 60 + 35 x 3 + 220 = 385 kWh/month
    expect(b.kwhMonth).toBe(385);
    expect(b.kwhSource).toBe('estimated');
    expect(b.baselineHomeEnergyKg).toBeCloseTo((385 * INDIA_GRID) / 30 / 3, 10);
    expect(b.baselineHomeEnergyKg).toBeCloseTo(3.0372222222222223, 10);
  });

  it('uses the Appendix A cooling adders', () => {
    expect(estimateKwhMonth(2, 'none')).toBe(60 + 35 * 2);
    expect(estimateKwhMonth(2, 'fan_only')).toBe(60 + 35 * 2 + 20);
    expect(estimateKwhMonth(2, 'ac_occasional')).toBe(60 + 35 * 2 + 90);
    expect(estimateKwhMonth(2, 'ac_daily')).toBe(60 + 35 * 2 + 220);
  });

  it('keeps a reported figure and divides it by the household', () => {
    const b = computeDailyBaseline(
      profile({
        householdSize: 4,
        coolingUsage: 'ac_occasional',
        electricityKwhMonth: 300,
        kwhSource: 'reported',
      }),
      { gridKgPerKwh: INDIA_GRID },
    );
    expect(b.kwhMonth).toBe(300);
    expect(b.kwhSource).toBe('reported');
    expect(b.baselineHomeEnergyKg).toBeCloseTo((300 * INDIA_GRID) / 30 / 4, 10);
    expect(b.baselineHomeEnergyKg).toBeCloseTo(1.775, 10);
  });

  it('preserves a bill-derived figure as from_bill', () => {
    const b = computeDailyBaseline(
      profile({ householdSize: 2, electricityKwhMonth: 210, kwhSource: 'from_bill' }),
    );
    expect(b.kwhSource).toBe('from_bill');
  });

  it('splits the cooling share out as the part a daily AC answer replaces', () => {
    const b = computeDailyBaseline(
      profile({ householdSize: 4, coolingUsage: 'ac_daily', electricityKwhMonth: 300 }),
      { gridKgPerKwh: INDIA_GRID },
    );
    // 300 reported, 220 of it attributed to cooling: 80 kWh stays at baseline.
    expect(b.baselineGridBaseKg).toBeCloseTo((80 * INDIA_GRID) / 30 / 4, 10);
    expect(b.baselineHomeEnergyKg).toBeCloseTo((300 * INDIA_GRID) / 30 / 4, 10);
  });

  it('floors the non-cooling share at zero when the reported kWh is lower', () => {
    const b = computeDailyBaseline(
      profile({ householdSize: 1, coolingUsage: 'ac_daily', electricityKwhMonth: 100 }),
      { gridKgPerKwh: INDIA_GRID },
    );
    expect(b.baselineGridBaseKg).toBe(0);
  });

  it('falls back to the CEA national average when the region is unknown', () => {
    const b = computeDailyBaseline(profile({ householdSize: 1, electricityKwhMonth: 300 }));
    expect(b.baselineHomeEnergyKg).toBeCloseTo((300 * 0.71) / 30, 10);
  });

  it('uses the regional grid factor over the national average', () => {
    const b = computeDailyBaseline(profile({ householdSize: 1, electricityKwhMonth: 300 }), {
      gridKgPerKwh: 0.92,
    });
    expect(b.baselineHomeEnergyKg).toBeCloseTo((300 * 0.92) / 30, 10);
  });

  it('multiplies grid draw by 0.35 with solar on site', () => {
    const base = { householdSize: 4, coolingUsage: 'ac_daily' as const, electricityKwhMonth: 300 };
    const withSolar = computeDailyBaseline(profile({ ...base, hasSolar: true }), {
      gridKgPerKwh: INDIA_GRID,
    });
    expect(withSolar.baselineHomeEnergyKg).toBeCloseTo(((300 * INDIA_GRID) / 30 / 4) * 0.35, 10);
    expect(withSolar.baselineHomeEnergyKg).toBeCloseTo(0.62125, 10);
    expect(withSolar.baselineGridBaseKg).toBeCloseTo(((80 * INDIA_GRID) / 30 / 4) * 0.35, 10);
  });
});

describe('home energy — cooking', () => {
  // Appendix A quotes all of these PER PERSON, so household size must not
  // divide them a second time.
  const fuels: ReadonlyArray<[CookingFuel, number]> = [
    ['lpg', (3.5 * 2.98) / 30],
    ['png', (1.5 * 2.0) / 30],
    ['electric_induction', 0.9 * INDIA_GRID],
    ['firewood', (3.5 * 1.75) / 30],
  ];

  for (const [fuel, kgPerPersonDay] of fuels) {
    it(`${fuel} is per person per day`, () => {
      const b = computeDailyBaseline(profile({ householdSize: 5, cookingFuel: fuel }), {
        gridKgPerKwh: INDIA_GRID,
      });
      expect(b.baselineCookKg).toBeCloseTo(kgPerPersonDay, 10);
    });
  }

  it('adds cooking on top of grid draw', () => {
    const b = computeDailyBaseline(
      profile({ householdSize: 2, electricityKwhMonth: 240, cookingFuel: 'lpg' }),
      { gridKgPerKwh: INDIA_GRID },
    );
    expect(b.baselineHomeEnergyKg).toBeCloseTo((240 * INDIA_GRID) / 30 / 2 + (3.5 * 2.98) / 30, 10);
  });
});

describe('water', () => {
  const levels: ReadonlyArray<[Level3, number]> = [
    ['low', 100],
    ['medium', 180],
    ['high', 300],
  ];

  for (const [level, litres] of levels) {
    it(`${level} is ${litres} litres at 0.0003 kg/litre`, () => {
      const b = computeDailyBaseline(profile({ waterUsageLevel: level }));
      expect(b.baselineWaterKg).toBeCloseTo(litres * 0.0003, 12);
    });
  }
});

describe('waste', () => {
  const habits: ReadonlyArray<[WasteHabit, number]> = [
    ['segregate_and_compost', 0.35],
    ['segregate_only', 0.7],
    ['none', 1.0],
  ];

  for (const [habit, multiplier] of habits) {
    it(`${habit} applies a ${multiplier} multiplier to per-capita MSW`, () => {
      const b = computeDailyBaseline(profile({ wasteHabit: habit }));
      // 0.45 kg/person/day x multiplier x 0.50 kg CO2e/kg
      expect(b.baselineWasteKg).toBeCloseTo(0.45 * multiplier * 0.5, 12);
    });
  }

  it('segregating and composting beats doing nothing', () => {
    const composting = computeDailyBaseline(profile({ wasteHabit: 'segregate_and_compost' }));
    const nothing = computeDailyBaseline(profile({ wasteHabit: 'none' }));
    expect(composting.baselineWasteKg).toBeLessThan(nothing.baselineWasteKg);
  });
});

describe('the MIN_PLAUSIBLE_KG clamp', () => {
  it('clamps a day under 1.5 kg and flags it', () => {
    // Water low (0.03) + composting waste (0.07875) = 0.10875 kg: not a day a
    // human lived through.
    const b = computeDailyBaseline(
      profile({ waterUsageLevel: 'low', wasteHabit: 'segregate_and_compost' }),
    );
    expect(b.baselineTotalKg).toBe(1.5);
    expect(b.clamped).toBe(true);
  });

  it('clamps an empty profile rather than reporting zero', () => {
    const b = computeDailyBaseline(profile());
    expect(b.baselineTotalKg).toBe(1.5);
    expect(b.clamped).toBe(true);
  });

  it('leaves the categories alone — only the headline total is floored', () => {
    const b = computeDailyBaseline(profile({ waterUsageLevel: 'low' }));
    expect(b.baselineWaterKg).toBeCloseTo(100 * 0.0003, 12);
    expect(b.baselineTransportKg).toBe(0);
  });

  it('does not clamp or flag a plausible day', () => {
    const b = computeDailyBaseline(profile({ dietType: 'vegetarian' }));
    expect(b.clamped).toBe(false);
    expect(b.baselineTotalKg).toBeCloseTo(3.81, 10);
  });

  it('is reusable on its own for the daily path', () => {
    expect(clampDailyKg(0.4)).toEqual({ totalKg: 1.5, clamped: true });
    expect(clampDailyKg(1.5)).toEqual({ totalKg: 1.5, clamped: false });
    expect(clampDailyKg(9)).toEqual({ totalKg: 9, clamped: false });
  });
});

describe('a whole baseline', () => {
  const realistic = profile({
    householdSize: 4,
    coolingUsage: 'ac_daily',
    dietType: 'non_veg_weekly',
    foodWasteLevel: 'medium',
    packagedFoodFreq: 'sometimes',
    primaryCommuteMode: 'car',
    vehicleFuel: 'petrol',
    commuteDistanceKm: 12,
    flightsPerYear: 1,
    electricityKwhMonth: 420,
    kwhSource: 'reported',
    cookingFuel: 'lpg',
    hasSolar: false,
    waterUsageLevel: 'medium',
    wasteHabit: 'segregate_only',
  });

  const transport = 12 * 2 * 0.171 * WEEKDAYS + (1 * 2200 * 0.154) / 365;
  const food = 4.67 * 1.08 + 0.3;
  const homeEnergy = (420 * INDIA_GRID) / 30 / 4 + (3.5 * 2.98) / 30;
  const water = 180 * 0.0003;
  const waste = 0.45 * 0.7 * 0.5;

  it('computes all five categories', () => {
    const b = computeDailyBaseline(realistic, { gridKgPerKwh: INDIA_GRID });
    expect(b.baselineTransportKg).toBeCloseTo(transport, 10);
    expect(b.baselineFoodKg).toBeCloseTo(food, 10);
    expect(b.baselineHomeEnergyKg).toBeCloseTo(homeEnergy, 10);
    expect(b.baselineWaterKg).toBeCloseTo(water, 10);
    expect(b.baselineWasteKg).toBeCloseTo(waste, 10);
  });

  it('totals them, unclamped', () => {
    const b = computeDailyBaseline(realistic, { gridKgPerKwh: INDIA_GRID });
    expect(b.baselineTotalKg).toBeCloseTo(transport + food + homeEnergy + water + waste, 10);
    expect(b.baselineTotalKg).toBeCloseTo(12.247414416210182, 9);
    expect(b.clamped).toBe(false);
  });

  it('no category is a hardcoded zero — v1 drew an empty slice', () => {
    const b = computeDailyBaseline(realistic, { gridKgPerKwh: INDIA_GRID });
    for (const kg of [
      b.baselineTransportKg,
      b.baselineFoodKg,
      b.baselineHomeEnergyKg,
      b.baselineWaterKg,
      b.baselineWasteKg,
    ]) {
      expect(kg).toBeGreaterThan(0);
    }
  });

  it('stamps the factor version that produced it', () => {
    expect(computeDailyBaseline(realistic).factorVersion).toBe(1);
  });
});
