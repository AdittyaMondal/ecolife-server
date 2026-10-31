import { errorResponses, jsonOk, notImplemented, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { createRoute } from '@hono/zod-openapi';
import { homeSchema } from './home.schema.ts';

export const homeRoutes = createModule();

homeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['home'],
    summary: 'The entire Home screen in one request',
    description: 'Budget: under 250 ms p95. One round trip, one payload, no client-side fan-out.',
    security: secured,
    responses: {
      200: jsonOk(homeSchema, 'Home payload'),
      401: errorResponses[401],
      403: errorResponses[403],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);
