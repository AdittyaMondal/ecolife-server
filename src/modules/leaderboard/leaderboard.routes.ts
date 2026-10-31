import { errorResponses, jsonOk, notImplemented, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { paginated } from '@common/openapi/params.ts';
import { createRoute } from '@hono/zod-openapi';
import {
  leaderboardQuerySchema,
  leaderboardRowSchema,
  myRankSchema,
} from './leaderboard.schema.ts';

export const leaderboardRoutes = createModule();

leaderboardRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['leaderboard'],
    summary: 'Points ranking',
    security: secured,
    request: { query: leaderboardQuerySchema },
    responses: {
      200: jsonOk(paginated(leaderboardRowSchema), 'Ranked page'),
      401: errorResponses[401],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

leaderboardRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/me',
    tags: ['leaderboard'],
    summary: 'Own rank, without paging to it',
    security: secured,
    responses: {
      200: jsonOk(myRankSchema, 'Own rank'),
      401: errorResponses[401],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);
