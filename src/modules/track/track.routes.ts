import { requireUser } from '@common/guards/auth.guard.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { errorResponses, jsonOk, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { idParam } from '@common/openapi/params.ts';
import { createRoute, z } from '@hono/zod-openapi';
import {
  dailyAnswersSchema,
  historyPointSchema,
  historyQuerySchema,
  logResultSchema,
  submitLogBodySchema,
  trackTodaySchema,
} from './track.schema.ts';
import * as service from './track.service.ts';

export const trackRoutes = createModule();

trackRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/today',
    tags: ['track'],
    summary: "Today's log if it exists, plus the question set and prefill defaults",
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(trackTodaySchema, "Today's state"),
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.today(c.get('user').id), 200),
);

trackRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/logs',
    tags: ['track'],
    summary: 'Submit the daily log — the core loop',
    description:
      'One transaction: validate, compute 5 categories, upsert the footprint, update the ' +
      'streak, evaluate the active goal, award rewards. Idempotent on (user, clientLogId), ' +
      'so an offline queue can replay safely. The response carries everything the result ' +
      'sheet needs — no refetch required.',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      body: { content: { 'application/json': { schema: submitLogBodySchema } }, required: true },
    },
    responses: {
      200: jsonOk(logResultSchema, 'Footprint computed and rewards granted'),
      400: errorResponses[400],
      401: errorResponses[401],
      422: errorResponses[422],
      429: errorResponses[429],
    },
  }),
  async (c) => ok(c, await service.submit(c.get('user').id, c.req.valid('json')), 200),
);

trackRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/logs/{id}',
    tags: ['track'],
    summary: 'Edit a log until 02:00 the next day',
    description:
      'The reduction bonus is computed once, on first submit, and is NOT re-granted on edit.',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: idParam,
      body: {
        content: { 'application/json': { schema: z.object({ answers: dailyAnswersSchema }) } },
        required: true,
      },
    },
    responses: {
      200: jsonOk(logResultSchema, 'Recomputed'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.edit(c.get('user').id, c.req.valid('param').id, c.req.valid('json').answers),
      200,
    ),
);

trackRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/history',
    tags: ['track'],
    summary: 'Footprint time series',
    middleware: [requireUser] as const,
    security: secured,
    request: { query: historyQuerySchema },
    responses: {
      200: jsonOk(z.object({ points: z.array(historyPointSchema) }), 'Series'),
      400: errorResponses[400],
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.history(c.get('user').id, c.req.valid('query')), 200),
);
