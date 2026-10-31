import { nullable } from '@common/openapi/envelope.ts';
import { dateString } from '@common/openapi/params.ts';
import { rewardGrantSchema } from '@common/openapi/shared-schemas.ts';
import { z } from '@hono/zod-openapi';

/** PRD-v2 §6.4. One active goal per user, enforced by a partial unique index. */

export const goalTypeSchema = z.enum(['reduce_percent', 'absolute_cap']);
export const goalPeriodSchema = z.enum(['week', 'month', 'quarter']);
export const goalStatusSchema = z.enum(['active', 'achieved', 'missed', 'cancelled']);

export const createGoalBodySchema = z
  .object({
    type: goalTypeSchema.openapi({ example: 'reduce_percent' }),
    period: goalPeriodSchema.openapi({ example: 'month' }),
    reducePercent: z
      .number()
      .min(1)
      .max(90)
      .optional()
      .openapi({ example: 15, description: 'Required when type is reduce_percent' }),
    capKgPerDay: z
      .number()
      .min(0.5)
      .max(100)
      .optional()
      .openapi({ description: 'Required when type is absolute_cap' }),
    startDate: dateString('2026-11-01'),
  })
  .openapi('CreateGoalBody');

/**
 * `targetKgTotal` is frozen at creation from a baseline snapshot.
 *
 * This is the fix for v1's defect C1: it derived a percentage goal's target
 * from the same running total it then compared against, so
 * `actual <= actual × (1 − p/100)` was false for every p > 0 and percentage
 * goals were mathematically unachievable.
 */
export const goalSchema = z
  .object({
    id: z.number().int().openapi({ example: 3 }),
    type: goalTypeSchema,
    period: goalPeriodSchema,
    reducePercent: z.number().nullable().openapi({ example: 15 }),
    capKgPerDay: z.number().nullable().openapi({ example: null }),
    startDate: z.string().openapi({ example: '2026-11-01' }),
    endDate: z.string().openapi({ example: '2026-11-30' }),
    baselineKgTotal: z.number().openapi({ example: 246 }),
    targetKgTotal: z.number().openapi({ example: 209.1 }),
    status: goalStatusSchema.openapi({ example: 'active' }),
    actualKgTotal: z.number().nullable().openapi({ example: 134.2 }),
    settledAt: z.string().nullable().openapi({ example: null }),
    createdAt: z.string().openapi({ example: '2026-10-31T09:00:00.000Z' }),
  })
  .openapi('Goal');

export const goalProgressSchema = z
  .object({
    goal: goalSchema,
    actualKgTotal: z.number().openapi({ example: 134.2 }),
    targetKgTotal: z.number().openapi({ example: 209.1 }),
    progressPct: z
      .number()
      .openapi({ example: 64.2, description: 'actual / target, as a percentage' }),
    daysElapsed: z.number().int().openapi({ example: 19 }),
    daysLeft: z.number().int().openapi({ example: 11 }),
    projectedKgTotal: z
      .number()
      .openapi({ example: 211.9, description: 'Linear projection at the current daily rate' }),
    onTrack: z.boolean().openapi({ example: true }),
  })
  .openapi('GoalProgress');

export const goalsListSchema = z
  .object({ active: nullable(goalSchema), past: z.array(goalSchema) })
  .openapi('GoalsList');

export const goalSettledSchema = z
  .object({ goal: goalSchema, reward: nullable(rewardGrantSchema) })
  .openapi('GoalSettled');
