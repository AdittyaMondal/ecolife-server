import { requireUser } from '@common/guards/auth.guard.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { errorResponses, jsonOk, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { createRoute } from '@hono/zod-openapi';
import { homeSchema } from './home.schema.ts';
import * as service from './home.service.ts';

export const homeRoutes = createModule();

homeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['home'],
    summary: 'The entire Home screen in one request',
    description: 'Budget: under 250 ms p95. One round trip, one payload, no client-side fan-out.',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(homeSchema, 'Home payload'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.home(c.get('user').id), 200),
);
