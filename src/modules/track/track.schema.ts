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

/**
 * A trip as it comes BACK out of storage.
 *
 * `daily_logs.trips` is jsonb, not a typed column, so a row written by an
 * older client or a future mode can hold a string this enum does not have —
 * `ride_sharing` is the live example, and the factor table already prices it.
 * Submitting is still restricted to the enum above; this looser shape exists
 * so reading a stored log echoes what is actually there instead of quietly
 * dropping a trip the user logged.
 */
export const storedTripSchema = z
  .object({
    mode: z.string().openapi({ example: 'bus' }),
    km: z.number().openapi({ example: 14.5 }),
  })
  .openapi('StoredTrip');

export const acHoursBucketSchema = z
  .enum(['0', '1_3', '4_8', '8_plus'])
  .openapi({ example: '1_3' });

export const bathChoiceSchema = z
  .enum(['bucket', 'short_shower', 'long_shower'])
  .openapi({ example: 'bucket' });

export const wasteActionSchema = z
  .enum(['segregated', 'composted', 'refused_plastic', 'none_of_these'])
  .openapi({ example: 'segregated' });

/** Shared by the submit body and the read shapes, minus the trips field. */
const answerFields = {
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
};

/** What a client may SEND. Trip modes are restricted to the enum. */
export const dailyAnswersSchema = z
  .object({
    /** Q1. Empty array means "did not travel"; omit the key entirely to fall back to baseline. */
    trips: z.array(tripSchema).max(20).optional(),
    ...answerFields,
  })
  .openapi('DailyAnswers');

/**
 * What the server RETURNS.
 *
 * `trips` and `wasteActions` are both jsonb columns, so a stored row can hold
 * a string these enums do not have. Submitting stays restricted to the enums;
 * reading echoes what is actually in the row rather than silently dropping it.
 */
export const storedAnswersSchema = z
  .object({
    ...answerFields,
    trips: z.array(storedTripSchema).optional(),
    wasteActions: z
      .array(z.string())
      .optional()
      .openapi({ example: ['segregated'] }),
  })
  .openapi('StoredDailyAnswers');

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
      .object({
        id: z.number().int(),
        answers: storedAnswersSchema,
        editableUntil: z.string().openapi({
          example: '2026-11-01T02:00:00+05:30',
          description:
            'An ISO-8601 instant WITH offset — 02:00 the day after the log, in the ' +
            "user's own timezone. Parse it as an instant; do not reinterpret the " +
            "wall time in the device's zone.",
        }),
      })
      .nullable(),
    askCooling: z
      .boolean()
      .openapi({ example: true, description: 'False when the profile reports no cooling' }),
    defaults: storedAnswersSchema.openapi({
      description:
        'The one-tap "Same as usual" prefill, derived from the baseline. `trips` holds ' +
        'the commute as TWO legs of equal distance, not one: onboarding records a ' +
        'one-way distance and a normal day is out and back. Label them as the outbound ' +
        'and return journey rather than collapsing them — editing one leg (worked from ' +
        'home in the afternoon, got a lift back) is the case this shape exists for. ' +
        'A `work_from_home` profile gets an empty array.',
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
