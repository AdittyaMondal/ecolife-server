import { userSummarySchema } from '@common/openapi/shared-schemas.ts';
import { z } from '@hono/zod-openapi';

/**
 * PRD-v2 §6.7. Backed by a materialised view refreshed every 5 minutes.
 *
 * Ranks break ties on `created_at ASC`, so equal scores order deterministically
 * instead of shuffling between requests. v1 loaded every user into memory and
 * ranked by array index.
 */

export const leaderboardRowSchema = userSummarySchema
  .extend({
    rank: z.number().int().openapi({ example: 1 }),
    pointsTotal: z.number().int().openapi({ example: 4820 }),
    currentStreak: z.number().int().openapi({ example: 31 }),
    isMe: z.boolean().openapi({ example: false }),
  })
  .openapi('LeaderboardRow');

export const leaderboardQuerySchema = z.object({
  period: z
    .enum(['all', 'month', 'week'])
    .default('all')
    .openapi({ param: { name: 'period', in: 'query' } }),
  scope: z
    .enum(['global', 'city'])
    .default('global')
    .openapi({ param: { name: 'scope', in: 'query' } }),
  cursor: z
    .string()
    .optional()
    .openapi({ param: { name: 'cursor', in: 'query' } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .openapi({
      param: { name: 'limit', in: 'query' },
    }),
});

export const myRankSchema = z
  .object({
    rank: z.number().int().nullable().openapi({ example: 12 }),
    pointsTotal: z.number().int().openapi({ example: 1240 }),
    totalRanked: z.number().int().openapi({ example: 318 }),
    percentile: z.number().openapi({ example: 96.2 }),
  })
  .openapi('MyRank');
