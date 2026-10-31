import { errorResponses, jsonOk, notImplemented, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { idParam } from '@common/openapi/params.ts';
import { createRoute } from '@hono/zod-openapi';
import {
  createGoalBodySchema,
  goalProgressSchema,
  goalSchema,
  goalsListSchema,
} from './goals.schema.ts';

export const goalRoutes = createModule();

goalRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['goals'],
    summary: 'Active goal and settled history',
    description: 'Goals are never deleted — they settle to achieved or missed and stay visible.',
    security: secured,
    responses: {
      200: jsonOk(goalsListSchema, 'Goals'),
      401: errorResponses[401],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

goalRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['goals'],
    summary: 'Create a goal, freezing its target',
    description: '409 when an active goal already exists — one per user, enforced by the database.',
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
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

goalRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['goals'],
    summary: 'Edit an active goal',
    description: 'Recomputes and re-freezes the target.',
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
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

goalRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}',
    tags: ['goals'],
    summary: 'Cancel a goal',
    description: "Sets status to 'cancelled'. The row is kept.",
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(goalSchema, 'Cancelled'),
      401: errorResponses[401],
      404: errorResponses[404],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

goalRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/progress',
    tags: ['goals'],
    summary: 'Actual vs frozen target, with a projection',
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(goalProgressSchema, 'Progress'),
      401: errorResponses[401],
      404: errorResponses[404],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);
