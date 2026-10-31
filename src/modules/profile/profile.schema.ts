import {
  breakdownSchema,
  userSummarySchema,
  walletSchema,
} from '@common/openapi/shared-schemas.ts';
import { z } from '@hono/zod-openapi';

/**
 * The 15 onboarding questions (PRD-v2 §3.2).
 *
 * Every field feeds a number in the baseline formula. If a question is added
 * here that does not change an emission figure or a recommendation, it does not
 * belong — v1 collected 32 answers and used 9 of them.
 */

export const level3 = z.enum(['low', 'medium', 'high']);
export const freq3 = z.enum(['rarely', 'sometimes', 'often']);
export const coolingUsageSchema = z.enum(['none', 'fan_only', 'ac_occasional', 'ac_daily']);
export const dietTypeSchema = z.enum([
  'vegan',
  'vegetarian',
  'eggetarian',
  'non_veg_weekly',
  'non_veg_daily',
]);
export const commuteModeSchema = z.enum([
  'walk',
  'cycle',
  'bus',
  'metro_train',
  'two_wheeler',
  'car',
  'cab',
  'auto_rickshaw',
  'work_from_home',
]);
export const vehicleFuelSchema = z.enum(['petrol', 'diesel', 'cng', 'electric', 'not_applicable']);
export const cookingFuelSchema = z.enum(['lpg', 'png', 'electric_induction', 'firewood']);
export const wasteHabitSchema = z.enum(['segregate_and_compost', 'segregate_only', 'none']);

/** Step 1 — household. */
export const step1Schema = z
  .object({
    householdSize: z.number().int().min(1).max(15).openapi({ example: 4 }),
    city: z.string().min(1).max(80).openapi({ example: 'Mumbai' }),
    regionCode: z.string().min(2).max(10).openapi({ example: 'IN-MH' }),
    coolingUsage: coolingUsageSchema.openapi({ example: 'ac_occasional' }),
  })
  .openapi('OnboardingStep1');

/** Step 2 — food. */
export const step2Schema = z
  .object({
    dietType: dietTypeSchema.openapi({ example: 'vegetarian' }),
    foodWasteLevel: level3.openapi({ example: 'low' }),
    packagedFoodFreq: freq3.openapi({ example: 'sometimes' }),
  })
  .openapi('OnboardingStep2');

/** Step 3 — travel. */
export const step3Schema = z
  .object({
    primaryCommuteMode: commuteModeSchema.openapi({ example: 'metro_train' }),
    vehicleFuel: vehicleFuelSchema.openapi({ example: 'not_applicable' }),
    commuteDistanceKm: z.number().min(0).max(200).openapi({
      example: 14.5,
      description: 'One way. Doubled and weighted 5/7 for the baseline.',
    }),
    flightsPerYear: z.number().int().min(0).max(50).openapi({ example: 2 }),
  })
  .openapi('OnboardingStep3');

/**
 * Step 4 — home energy.
 *
 * `electricityKwhMonth` is nullable on purpose: most people do not know it. The
 * client offers exact kWh, the monthly bill (divided by a seeded per-region
 * tariff), or "I don't know" — and `kwhSource` records which, so the UI can
 * label an estimated footprint as an estimate.
 */
export const step4Schema = z
  .object({
    electricityKwhMonth: z.number().min(0).max(2000).nullable().openapi({ example: 240 }),
    electricityBillInr: z.number().int().min(0).nullable().optional().openapi({ example: null }),
    kwhSource: z.enum(['reported', 'from_bill', 'estimated']).openapi({ example: 'reported' }),
    cookingFuel: cookingFuelSchema.openapi({ example: 'lpg' }),
    hasSolar: z.boolean().openapi({ example: false }),
  })
  .openapi('OnboardingStep4');

/** Step 5 — water and waste. */
export const step5Schema = z
  .object({
    waterUsageLevel: level3.openapi({ example: 'medium' }),
    wasteHabit: wasteHabitSchema.openapi({ example: 'segregate_only' }),
  })
  .openapi('OnboardingStep5');

export const stepParam = z.object({
  n: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .openapi({ param: { name: 'n', in: 'path' }, example: 3 }),
});

/** Any one step's answers. The server validates against the step in the path. */
export const stepBodySchema = z
  .union([step1Schema, step2Schema, step3Schema, step4Schema, step5Schema])
  .openapi('OnboardingStepBody');

export const onboardingStateSchema = z
  .object({
    completedSteps: z.number().int().min(0).max(5).openapi({ example: 3 }),
    complete: z.boolean().openapi({ example: false }),
    answers: z
      .object({
        ...step1Schema.partial().shape,
        ...step2Schema.partial().shape,
        ...step3Schema.partial().shape,
        ...step4Schema.partial().shape,
        ...step5Schema.partial().shape,
      })
      .openapi('OnboardingAnswers'),
  })
  .openapi('OnboardingState');

/** kg CO₂e per day, per category, derived from the 15 answers. */
export const baselineSchema = breakdownSchema.openapi('Baseline');

export const onboardingCompleteResultSchema = z
  .object({
    baseline: baselineSchema,
    wallet: walletSchema,
    pointsAwarded: z.number().int().openapi({ example: 100 }),
    coinsAwarded: z.number().int().openapi({ example: 50 }),
  })
  .openapi('OnboardingCompleteResult');

export const ownProfileSchema = z
  .object({
    user: userSummarySchema,
    timezone: z.string().openapi({ example: 'Asia/Kolkata' }),
    wallet: walletSchema,
    baseline: baselineSchema,
    answers: onboardingStateSchema.shape.answers,
    memberSince: z.string().openapi({ example: '2026-10-31T09:35:00.000Z' }),
  })
  .openapi('OwnProfile');

/** Public profile. Deliberately excludes footprint, answers, coins and email. */
export const publicProfileSchema = z
  .object({
    user: userSummarySchema,
    pointsTotal: z.number().int().openapi({ example: 1240 }),
    globalRank: z.number().int().nullable().openapi({ example: 12 }),
    currentStreak: z.number().int().openapi({ example: 12 }),
    eventsAttended: z.number().int().openapi({ example: 3 }),
    memberSince: z.string().openapi({ example: '2026-08-02T00:00:00.000Z' }),
  })
  .openapi('PublicProfile');

export const rewardEntrySchema = z
  .object({
    id: z.number().int().openapi({ example: 9001 }),
    pointsDelta: z.number().int().openapi({ example: 200 }),
    coinsDelta: z.number().int().openapi({ example: 100 }),
    source: z
      .enum([
        'onboarding',
        'daily_log',
        'streak',
        'reduction',
        'goal',
        'event_attend',
        'event_host',
        'order',
        'order_refund',
        'admin',
      ])
      .openapi({ example: 'event_attend' }),
    note: z.string().nullable().openapi({ example: 'Beach clean-up, Versova' }),
    createdAt: z.string().openapi({ example: '2026-10-30T07:12:00.000Z' }),
  })
  .openapi('RewardEntry');
