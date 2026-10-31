import { requireUser } from '@common/guards/auth.guard.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { errorResponses, jsonOk, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { paginated } from '@common/openapi/params.ts';
import { createRoute } from '@hono/zod-openapi';
import {
  leaderboardQuerySchema,
  leaderboardRowSchema,
  myRankSchema,
} from './leaderboard.schema.ts';
import * as service from './leaderboard.service.ts';

export const leaderboardRoutes = createModule();

leaderboardRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['leaderboard'],
    summary: 'Points ranking',
    middleware: [requireUser] as const,
    security: secured,
    request: { query: leaderboardQuerySchema },
    responses: {
      200: jsonOk(paginated(leaderboardRowSchema), 'Ranked page'),
      400: errorResponses[400],
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.board(c.get('user').id, c.req.valid('query')), 200),
);

leaderboardRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/me',
    tags: ['leaderboard'],
    summary: 'Own rank, without paging to it',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(myRankSchema, 'Own rank'),
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.myRank(c.get('user').id), 200),
);
