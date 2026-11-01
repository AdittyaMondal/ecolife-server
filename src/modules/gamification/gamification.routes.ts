import { ok } from '@common/interceptors/response-envelope.ts';
import { errorResponses, jsonOk } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { paginated, slugParam } from '@common/openapi/params.ts';
import { createRoute, z } from '@hono/zod-openapi';
import { raritySchema, treeQuerySchema, treeSchema } from './gamification.schema.ts';
import * as service from './gamification.service.ts';

export const treeRoutes = createModule();

/**
 * `/rarities` is declared BEFORE `/{slug}` on purpose. Hono prefers a static
 * segment, but relying on that silently is how a sibling route starts
 * answering 404 for a perfectly good URL the day the order changes.
 */
treeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/rarities',
    tags: ['gamification'],
    summary: 'Rarity tiers and their drop weights — public',
    description:
      'Weights are relative, not percentages: divide one by the sum of the active tiers. ' +
      'Published deliberately — the roll is server-side, so the odds cost nothing to disclose.',
    responses: {
      200: jsonOk(z.object({ items: z.array(raritySchema) }), 'Rarity tiers, rarest last'),
    },
  }),
  async (c) => ok(c, await service.listRarities(), 200),
);

treeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['gamification'],
    summary: 'The tree catalogue — public',
    description:
      'Every tree a user can be rewarded with. `rarity` filters by rarity slug; an unknown ' +
      'slug is an empty page rather than a 404, so a stale filter does not look like an outage.',
    request: { query: treeQuerySchema },
    responses: {
      200: jsonOk(paginated(treeSchema), 'Catalogue, newest first'),
      400: errorResponses[400],
    },
  }),
  async (c) => ok(c, await service.listTrees(c.req.valid('query')), 200),
);

treeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{slug}',
    tags: ['gamification'],
    summary: 'One catalogue entry — public',
    request: { params: slugParam('neem') },
    responses: {
      200: jsonOk(treeSchema, 'Tree'),
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.treeBySlug(c.req.valid('param').slug), 200),
);
