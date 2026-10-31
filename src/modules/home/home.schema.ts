import { nullable } from '@common/openapi/envelope.ts';
import {
  breakdownSchema,
  categorySourceSchema,
  streakSchema,
  userSummarySchema,
  walletSchema,
} from '@common/openapi/shared-schemas.ts';
import { z } from '@hono/zod-openapi';

/**
 * The whole Home screen in one payload (PRD-v2 §6.2).
 *
 * Deliberately one request. v1's dashboard fired six separate SUM() queries
 * plus a day-by-day loop on every page load.
 */

export const todaySchema = z
  .object({
    date: z.string().openapi({ example: '2026-10-31' }),
    logged: z.boolean().openapi({ example: true, description: 'False drives the "Log today" CTA' }),
    breakdown: breakdownSchema,
    baselineTotalKg: z.number().openapi({ example: 8.2 }),
    deltaKg: z.number().openapi({ example: -2.15, description: 'Negative is an improvement' }),
    percentOfBaseline: z.number().openapi({ example: 73.8 }),
    sources: categorySourceSchema,
    inferredCount: z
      .number()
      .int()
      .openapi({ example: 2, description: 'Categories that fell back to baseline' }),
  })
  .openapi('HomeToday');

export const weekSchema = z
  .object({
    sparkline: z.array(z.object({ date: z.string(), totalKg: z.number() })).openapi({
      example: [
        { date: '2026-10-25', totalKg: 7.9 },
        { date: '2026-10-26', totalKg: 8.4 },
        { date: '2026-10-27', totalKg: 6.6 },
        { date: '2026-10-28', totalKg: 7.1 },
        { date: '2026-10-29', totalKg: 6.9 },
        { date: '2026-10-30', totalKg: 7.3 },
        { date: '2026-10-31', totalKg: 6.05 },
      ],
    }),
    avgKgPerDay: z.number().openapi({ example: 7.18 }),
    changeVsLastWeekPct: z.number().openapi({ example: -8.9 }),
  })
  .openapi('HomeWeek');

export const activeGoalSummarySchema = z
  .object({
    id: z.number().int().openapi({ example: 3 }),
    label: z.string().openapi({ example: 'Cut 15% this month' }),
    progressPct: z.number().openapi({ example: 64 }),
    daysLeft: z.number().int().openapi({ example: 11 }),
    onTrack: z.boolean().openapi({ example: true }),
  })
  .openapi('ActiveGoalSummary');

export const leaderboardPeekSchema = z
  .object({
    top: z
      .array(userSummarySchema.extend({ pointsTotal: z.number().int(), rank: z.number().int() }))
      .openapi({ description: 'Top 3' }),
    me: z
      .object({ rank: z.number().int().nullable(), pointsTotal: z.number().int() })
      .openapi({ example: { rank: 12, pointsTotal: 1240 } }),
  })
  .openapi('LeaderboardPeek');

export const nextEventSchema = z
  .object({
    id: z.number().int().openapi({ example: 5 }),
    slug: z.string().openapi({ example: 'beach-cleanup-versova' }),
    title: z.string().openapi({ example: 'Beach clean-up, Versova' }),
    startAt: z.string().openapi({ example: '2026-11-02T01:30:00.000Z' }),
    venueName: z.string().openapi({ example: 'Versova Beach' }),
    passReady: z.boolean().openapi({ example: true }),
  })
  .openapi('NextEvent');

export const homeSchema = z
  .object({
    greetingName: z.string().openapi({ example: 'Adittya' }),
    wallet: walletSchema,
    today: todaySchema,
    streak: streakSchema,
    week: weekSchema,
    breakdown30d: breakdownSchema,
    activeGoal: nullable(activeGoalSummarySchema),
    leaderboard: leaderboardPeekSchema,
    nextEvent: nullable(nextEventSchema),
  })
  .openapi('Home');
