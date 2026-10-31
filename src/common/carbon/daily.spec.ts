import { describe, expect, it } from 'bun:test';
import {
  acGridKg,
  computeDailyFootprint,
  type DailyContext,
  reductionPct,
  type StoredBaseline,
  wasteMultiplierFromActions,
} from './calculate.ts';
import { MIN_PLAUSIBLE_KG, WASTE_MULTIPLIER_FLOOR } from './factors.ts';

/** The daily footprint (PRD-v2 §3.5). Pure, so no fixture needed. */

const BASELINE: StoredBaseline = {
  baselineTransportKg: 3.0,
  baselineFoodKg: 4.0,
  baselineHomeEnergyKg: 2.0,
  baselineWaterKg: 0.054,
  baselineWasteKg: 0.157,
  baselineTotalKg: 9.211,
  baselineFlightKg: 0.5,
  baselineCookKg: 0.35,
  baselineGridBaseKg: 1.1,
};

const PROFILE: DailyContext = {
  householdSize: 4,
  foodWasteLevel: 'low',
  packagedFoodFreq: 'rarely',
  hasSolar: false,
};

describe('a skipped question falls back to baseline', () => {
  it('inherits every category when nothing is answered', () => {
    const r = computeDailyFootprint({}, BASELINE, PROFILE);
    expect(r.transportKg).toBe(BASELINE.baselineTransportKg);
    expect(r.foodKg).toBe(BASELINE.baselineFoodKg);
    expect(r.homeEnergyKg).toBe(BASELINE.baselineHomeEnergyKg);
    expect(r.waterKg).toBe(BASELINE.baselineWaterKg);
    expect(r.wasteKg).toBe(BASELINE.baselineWasteKg);
    expect(r.answeredCount).toBe(0);
    expect(Object.values(r.sources).every((s) => s === 'inferred')).toBe(true);
  });

  it('distinguishes "did not travel" from "did not answer"', () => {
    // The difference the whole sources column exists for. An empty array is a
    // logged zero; an absent key inherits the onboarding commute.
    const skipped = computeDailyFootprint({}, BASELINE, PROFILE);
    const noTravel = computeDailyFootprint({ trips: [] }, BASELINE, PROFILE);

    expect(skipped.sources.transport).toBe('inferred');
    expect(skipped.transportKg).toBe(3.0);

    expect(noTravel.sources.transport).toBe('logged');
    // Flights stay amortised even on a day with no trips — the daily log
    // never asks about them, so dropping them would be a free discount.
    expect(noTravel.transportKg).toBe(BASELINE.baselineFlightKg);
  });

  it('counts only answered categories', () => {
    const r = computeDailyFootprint(
      { trips: [], vegMeals: 3, bathChoice: 'bucket' },
      BASELINE,
      PROFILE,
    );
    expect(r.answeredCount).toBe(3);
    expect(r.sources.home_energy).toBe('inferred');
    expect(r.sources.waste).toBe('inferred');
  });
});

describe('transport', () => {
  it('prices each trip by its own mode', () => {
    const r = computeDailyFootprint(
      {
        trips: [
          { mode: 'bus', km: 10 },
          { mode: 'car', km: 5 },
        ],
      },
      BASELINE,
      PROFILE,
    );
    // 10 x 0.027 + 5 x 0.171 (car with no fuel stated resolves to petrol)
    expect(r.transportKg).toBeCloseTo(0.27 + 0.855 + BASELINE.baselineFlightKg, 5);
  });

  it('throws on a mode it cannot price, rather than scoring it zero', () => {
    // v1 zeroed a whole transport mode through an unhandled switch case and
    // nobody noticed, because a missing number looks exactly like a good day.
    expect(() =>
      computeDailyFootprint({ trips: [{ mode: 'teleport', km: 10 }] }, BASELINE, PROFILE),
    ).toThrow();
  });
});

describe('food', () => {
  it('prices meals at a third of the daily cohort figure', () => {
    const r = computeDailyFootprint({ vegMeals: 3 }, BASELINE, PROFILE);
    // 3 x (3.81 / 3) x 1.00 waste multiplier + 0 packaging
    expect(r.foodKg).toBeCloseTo(3.81, 5);
  });

  it('still applies the profile multiplier and packaging adder', () => {
    const heavy = computeDailyFootprint({ vegMeals: 3 }, BASELINE, {
      ...PROFILE,
      foodWasteLevel: 'high',
      packagedFoodFreq: 'often',
    });
    expect(heavy.foodKg).toBeCloseTo(3.81 * 1.18 + 0.7, 5);
  });
});

describe('home energy', () => {
  it('replaces only the cooling share, keeping cooking and the grid base', () => {
    const r = computeDailyFootprint({ acHoursBucket: '0' }, BASELINE, PROFILE);
    // With no AC the day is exactly cooking + lights/fridge.
    expect(r.homeEnergyKg).toBeCloseTo(BASELINE.baselineCookKg + BASELINE.baselineGridBaseKg, 5);
  });

  it('divides AC draw across the household', () => {
    const alone = acGridKg('4_8', 0.71, 1, false);
    const shared = acGridKg('4_8', 0.71, 4, false);
    expect(shared).toBeCloseTo(alone / 4, 5);
    // 6 hours x 1.5 kWh x 0.71
    expect(alone).toBeCloseTo(6 * 1.5 * 0.71, 5);
  });

  it('applies the solar offset to AC draw as it does to the baseline', () => {
    expect(acGridKg('4_8', 0.71, 1, true)).toBeCloseTo(acGridKg('4_8', 0.71, 1, false) * 0.35, 5);
  });
});

describe('waste actions', () => {
  it('subtracts per action from 1.00', () => {
    expect(wasteMultiplierFromActions([])).toBe(1);
    expect(wasteMultiplierFromActions(['segregated'])).toBeCloseTo(0.7, 5);
    expect(wasteMultiplierFromActions(['segregated', 'refused_plastic'])).toBeCloseTo(0.65, 5);
  });

  it('floors the multiplier so actions cannot stack to zero', () => {
    const all = wasteMultiplierFromActions(['segregated', 'composted', 'refused_plastic']);
    expect(all).toBe(WASTE_MULTIPLIER_FLOOR);
  });

  it('ignores an action it does not know instead of throwing', () => {
    // Unlike a transport mode, an unknown action can only fail to apply a
    // discount — it can never understate the footprint.
    expect(wasteMultiplierFromActions(['invented'])).toBe(1);
  });
});

describe('plausibility floor', () => {
  it('clamps an implausibly low day and flags it', () => {
    const empty: StoredBaseline = { ...BASELINE, baselineFlightKg: 0 };
    const r = computeDailyFootprint(
      { trips: [], vegMeals: 0, nonVegMeals: 0, veganMeals: 0 },
      { ...empty, baselineCookKg: 0, baselineGridBaseKg: 0 },
      PROFILE,
      null,
    );
    // Only food and transport answered, both near zero, so the remaining
    // inferred categories are tiny — the total lands under the floor.
    if (r.totalKg === MIN_PLAUSIBLE_KG) expect(r.clamped).toBe(true);
    expect(r.totalKg).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_KG);
  });
});

describe('reduction percentage', () => {
  it('never reports a negative reduction', () => {
    // A worse-than-baseline day is 0%, not -12%. The bonus reads this.
    expect(reductionPct(12, 9)).toBe(0);
  });

  it('rounds to two places', () => {
    expect(reductionPct(6, 9)).toBeCloseTo(33.33, 2);
  });

  it('is zero when there is no baseline to beat', () => {
    expect(reductionPct(5, 0)).toBe(0);
  });
});
