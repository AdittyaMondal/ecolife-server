import { dateString } from '@common/openapi/params.ts';
import {
  breakdownSchema,
  categorySourceSchema,
  rewardGrantSchema,
  streakSchema,
  walletSchema,
} from '@common/openapi/shared-schemas.ts';
import { z } from '@hono/zod-openapi';
import { commuteModeSchema } from '@modules/profile/profile.schema.ts';

/** The 5 daily questions (PRD-v2 §3.4). Target: under 30 seconds, one thumb. */

export const tripSchema = z
  .object({
    mode: commuteModeSchema.openapi({ example: 'bus' }),
    km: z.number().min(0).max(500).openapi({ example: 14.5 }),
  })
  .openapi('Trip');

export const acHoursBucketSchema = z
  .enum(['0', '1_3', '4_8', '8_plus'])
  .openapi({ example: '1_3' });

export const bathChoiceSchema = z
  .enum(['bucket', 'short_shower', 'long_shower'])
  .openapi({ example: 'bucket' });

export const wasteActionSchema = z
  .enum(['segregated', 'composted', 'refused_plastic', 'none_of_these'])
  .openapi({ example: 'segregated' });

export const dailyAnswersSchema = z
  .object({
    /** Q1. Empty array means "did not travel"; omit the key entirely to fall back to baseline. */
    trips: z.array(tripSchema).max(20).optional(),
    /** Q2. */
    vegMeals: z.number().int().min(0).max(10).optional().openapi({ example: 2 }),
    nonVegMeals: z.number().int().min(0).max(10).optional().openapi({ example: 0 }),
    veganMeals: z.number().int().min(0).max(10).optional().openapi({ example: 1 }),
    /** Q3. Only asked when the profile says cooling is used at all. */
    acHoursBucket: acHoursBucketSchema.optional(),
    /** Q4. */
    bathChoice: bathChoiceSchema.optional(),
    /** Q5. */
    wasteActions: z.array(wasteActionSchema).max(4).optional(),
  })
  .openapi('DailyAnswers');

export const submitLogBodySchema = z
  .object({
    /**
     * Client-generated UUIDv7. The server deduplicates on (userId, clientLogId),
     * which is what makes the mobile offline queue safe to replay (PRD-v2 §10.3).
     */
    clientLogId: z.string().uuid().openapi({ example: '0193f0a2-7c31-7b4e-9a51-6b2e0f3c4d55' }),
    logDate: dateString('2026-10-31').openapi({
      description: "The user's LOCAL date. Must be today or yesterday in their timezone.",
    }),
    answers: dailyAnswersSchema,
  })
  .openapi('SubmitLogBody');

/** What `GET /track/today` returns so the client can prefill "Same as usual". */
export const trackTodaySchema = z
  .object({
    date: z.string().openapi({ example: '2026-10-31' }),
    existingLog: z
      .object({ id: z.number().int(), answers: dailyAnswersSchema, editableUntil: z.string() })
      .nullable(),
    askCooling: z
      .boolean()
      .openapi({ example: true, description: 'False when the profile reports no cooling' }),
    defaults: dailyAnswersSchema.openapi({
      description: 'The one-tap "Same as usual" prefill, derived from the baseline',
    }),
  })
  .openapi('TrackToday');

export const logResultSchema = z
  .object({
    logId: z.number().int().openapi({ example: 812 }),
    breakdown: breakdownSchema,
    baselineTotalKg: z.number().openapi({ example: 8.2 }),
    deltaKg: z.number().openapi({ example: -2.15 }),
    reductionPct: z.number().openapi({ example: 26.2 }),
    sources: categorySourceSchema,
    clamped: z
      .boolean()
      .openapi({ example: false, description: 'True when the day fell below MIN_PLAUSIBLE_KG' }),
    reward: rewardGrantSchema,
    wallet: walletSchema,
    streak: streakSchema,
  })
  .openapi('LogResult');

export const historyPointSchema = z
  .object({
    date: z.string().openapi({ example: '2026-10-31' }),
    totalKg: z.number().openapi({ example: 6.05 }),
    baselineTotalKg: z.number().openapi({ example: 8.2 }),
    logged: z.boolean().openapi({ example: true }),
  })
  .openapi('HistoryPoint');

export const historyQuerySchema = z.object({
  from: dateString('2026-10-01').openapi({ param: { name: 'from', in: 'query' } }),
  to: dateString('2026-10-31').openapi({ param: { name: 'to', in: 'query' } }),
  granularity: z
    .enum(['day', 'week', 'month'])
    .default('day')
    .openapi({ param: { name: 'granularity', in: 'query' } }),
});
