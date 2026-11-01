import { nullable } from '@common/openapi/envelope.ts';
import { z } from '@hono/zod-openapi';

/**
 * Wire contract for the gamification module (PRD-v2 §4.5).
 *
 * Rarity drop weights are PUBLIC on purpose. The roll is server-side and the
 * client cannot influence it (§4.5), so publishing the odds costs nothing in
 * integrity and is the difference between a reward and a slot machine.
 */

export const raritySchema = z
  .object({
    id: z.number().int().openapi({ example: 3 }),
    slug: z.string().openapi({ example: 'rare' }),
    name: z.string().openapi({ example: 'Rare' }),
    rank: z
      .number()
      .int()
      .openapi({ example: 3, description: '1 is the most common tier; higher is rarer.' }),
    dropWeight: z.number().int().openapi({
      example: 100,
      description: 'Relative likelihood, not a percentage. Divide by the sum of active tiers.',
    }),
    isActive: z.boolean().openapi({ example: true }),
  })
  .openapi('TreeRarity');

export const growthStageSchema = z
  .object({
    stage: z.number().int().openapi({ example: 2 }),
    label: z.string().openapi({ example: 'Sapling' }),
    imageUrl: z.string().openapi({
      example:
        'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?auto=format&fit=crop&w=1200&q=80',
    }),
  })
  .openapi('GrowthStage');

export const treeSchema = z
  .object({
    id: z.number().int().openapi({ example: 7 }),
    slug: z.string().openapi({ example: 'neem' }),
    name: z.string().openapi({ example: 'Neem' }),
    description: z
      .string()
      .openapi({ example: 'Azadirachta indica. Shade, medicine and a mosquito deterrent.' }),
    rarity: raritySchema,
    imageUrl: z.string().openapi({
      example:
        'https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?auto=format&fit=crop&w=800&q=80',
    }),
    growthStages: nullable(z.array(growthStageSchema)).openapi({
      description: 'Null when the tree has one artwork and no progression.',
    }),
    co2OffsetKgPerYear: z
      .number()
      .openapi({ example: 48.5, description: 'Why a tree is the reward and not a sticker.' }),
    isActive: z.boolean().openapi({ example: true }),
  })
  .openapi('Tree');

/** Catalogue listing. `rarity` filters by rarity SLUG, not id. */
export const treeQuerySchema = z.object({
  rarity: z
    .string()
    .optional()
    .openapi({ param: { name: 'rarity', in: 'query' }, example: 'rare' }),
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
    .openapi({ param: { name: 'limit', in: 'query' }, example: 20 }),
});
