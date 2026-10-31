import { z } from '@hono/zod-openapi';

/**
 * Schemas used by more than one module.
 *
 * Module-owned shapes belong in that module's `x.schema.ts` (CLAUDE.md §4.4).
 * These are the handful that genuinely cross boundaries — a user summary is
 * rendered by the leaderboard, a participant list and a public profile, and
 * duplicating it three times guarantees the three drift.
 */

export const emissionCategorySchema = z
  .enum(['transport', 'food', 'home_energy', 'water', 'waste'])
  .openapi('EmissionCategory');

/** Which categories came from a real answer vs. fell back to the baseline (PRD-v2 §3.5). */
export const categorySourceSchema = z
  .record(emissionCategorySchema, z.enum(['logged', 'inferred']))
  .openapi({ example: { transport: 'logged', food: 'logged', water: 'inferred' } });

export const breakdownSchema = z
  .object({
    transportKg: z.number().openapi({ example: 2.74 }),
    foodKg: z.number().openapi({ example: 1.27 }),
    homeEnergyKg: z.number().openapi({ example: 1.83 }),
    waterKg: z.number().openapi({ example: 0.05 }),
    wasteKg: z.number().openapi({ example: 0.16 }),
    totalKg: z.number().openapi({ example: 6.05 }),
  })
  .openapi('Breakdown');

/** The minimum needed to render someone else in a list. Never their footprint. */
export const userSummarySchema = z
  .object({
    id: z.number().int().openapi({ example: 7 }),
    name: z.string().openapi({ example: 'Yusuf' }),
    avatarUrl: z.string().nullable().openapi({ example: null }),
    city: z.string().nullable().openapi({ example: 'Mumbai' }),
  })
  .openapi('UserSummary');

/**
 * A URL the server will hand to other people's browsers.
 *
 * `z.string()` alone accepts `javascript:...` and `data:text/html,...`, and an
 * avatar URL is rendered in every leaderboard row, participant list and public
 * profile — so one account can reach every viewer. https-only also stops the
 * cheaper version of the same trick: pointing it at an attacker-controlled
 * host that logs the IP of everyone who loads the page.
 *
 * Once POST /uploads/presign exists this should narrow further, to URLs the
 * app's own storage issued. Until there is a bucket to compare against,
 * scheme and length are what can honestly be enforced.
 */
export const externalImageUrlSchema = z
  .string()
  .url()
  .max(512)
  .refine((u) => u.startsWith('https://'), { message: 'must be an https URL' })
  .openapi({ example: 'https://cdn.ecolife.app/avatars/abc123.webp' });

export const walletSchema = z
  .object({
    pointsTotal: z.number().int().openapi({ example: 1240 }),
    coinsBalance: z.number().int().openapi({ example: 420 }),
  })
  .openapi('Wallet');

/** What an earn/spend event returns so a client can animate it immediately. */
export const rewardGrantSchema = z
  .object({
    pointsDelta: z.number().int().openapi({ example: 19 }),
    coinsDelta: z.number().int().openapi({ example: 9 }),
    reasons: z
      .array(z.object({ source: z.string(), points: z.number().int(), coins: z.number().int() }))
      .openapi({
        example: [
          { source: 'daily_log', points: 10, coins: 5 },
          { source: 'reduction', points: 9, coins: 4 },
        ],
      }),
  })
  .openapi('RewardGrant');

export const streakSchema = z
  .object({
    current: z.number().int().openapi({ example: 12 }),
    longest: z.number().int().openapi({ example: 23 }),
  })
  .openapi('Streak');

export const moneySchema = z
  .number()
  .int()
  .openapi({ example: 24000, description: 'Integer paise. Never a float. 24000 = ₹240.00' });
