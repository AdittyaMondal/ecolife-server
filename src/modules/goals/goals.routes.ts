import { requireUser } from '@common/guards/auth.guard.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { errorResponses, jsonOk, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { idParam } from '@common/openapi/params.ts';
import { createRoute } from '@hono/zod-openapi';
import {
  createGoalBodySchema,
  goalProgressSchema,
  goalSchema,
  goalsListSchema,
} from './goals.schema.ts';
import * as service from './goals.service.ts';

export const goalRoutes = createModule();

goalRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['goals'],
    summary: 'Active goal and settled history',
    description: 'Goals are never deleted — they settle to achieved or missed and stay visible.',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(goalsListSchema, 'Goals'),
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.list(c.get('user').id), 200),
);

goalRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['goals'],
    summary: 'Create a goal, freezing its target',
    description: '409 when an active goal already exists — one per user, enforced by the database.',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      body: { content: { 'application/json': { schema: createGoalBodySchema } }, required: true },
    },
    responses: {
      201: jsonOk(goalSchema, 'Created'),
      400: errorResponses[400],
      401: errorResponses[401],
      409: errorResponses[409],
      422: errorResponses[422],
    },
  }),
  async (c) => ok(c, await service.create(c.get('user').id, c.req.valid('json')), 201),
);

goalRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['goals'],
    summary: 'Edit an active goal',
    description: 'Recomputes and re-freezes the target.',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: idParam,
      body: { content: { 'application/json': { schema: createGoalBodySchema.partial() } } },
    },
    responses: {
      200: jsonOk(goalSchema, 'Updated'),
      401: errorResponses[401],
      404: errorResponses[404],
      422: errorResponses[422],
    },
  }),
  async (c) =>
    ok(c, await service.patch(c.get('user').id, c.req.valid('param').id, c.req.valid('json')), 200),
);

goalRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}',
    tags: ['goals'],
    summary: 'Cancel a goal',
    description: "Sets status to 'cancelled'. The row is kept.",
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(goalSchema, 'Cancelled'),
      401: errorResponses[401],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.cancel(c.get('user').id, c.req.valid('param').id), 200),
);

goalRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/progress',
    tags: ['goals'],
    summary: 'Actual vs frozen target, with a projection',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(goalProgressSchema, 'Progress'),
      401: errorResponses[401],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.progress(c.get('user').id, c.req.valid('param').id), 200),
);
