import { requireUser } from '@common/guards/auth.guard.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { errorResponses, jsonOk, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { idParam, paginated, slugParam } from '@common/openapi/params.ts';
import { createRoute, z } from '@hono/zod-openapi';
import {
  coHostBodySchema,
  createEventBodySchema,
  eventListQuerySchema,
  eventSchema,
  participantListSchema,
  passSchema,
  registerResultSchema,
  scanBodySchema,
  scanResultSchema,
} from './events.schema.ts';
import * as service from './events.service.ts';

export const eventRoutes = createModule();

eventRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['events'],
    summary: 'Discover events',
    description: 'The `nearby` filter requires lat/lng and ranks by Haversine distance in SQL.',
    middleware: [requireUser] as const,
    security: secured,
    request: { query: eventListQuerySchema },
    responses: {
      200: jsonOk(paginated(eventSchema), 'Events'),
      400: errorResponses[400],
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.list(c.get('user').id, c.req.valid('query')), 200),
);

eventRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['events'],
    summary: 'Create an event — the creator becomes its host',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      body: { content: { 'application/json': { schema: createEventBodySchema } }, required: true },
    },
    responses: {
      201: jsonOk(eventSchema, 'Created'),
      400: errorResponses[400],
      401: errorResponses[401],
      422: errorResponses[422],
    },
  }),
  async (c) => ok(c, await service.create(c.get('user').id, c.req.valid('json')), 201),
);

eventRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{slug}',
    tags: ['events'],
    summary: 'Event detail with viewer-relative state',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: slugParam('versova-beach-cleanup') },
    responses: {
      200: jsonOk(eventSchema, 'Event'),
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.bySlug(c.req.valid('param').slug, c.get('user').id), 200),
);

eventRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['events'],
    summary: 'Edit an event (host only)',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: idParam,
      body: { content: { 'application/json': { schema: createEventBodySchema.partial() } } },
    },
    responses: {
      200: jsonOk(eventSchema, 'Updated'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.update(c.get('user').id, c.req.valid('param').id, c.req.valid('json')),
      200,
    ),
);

eventRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/cancel',
    tags: ['events'],
    summary: 'Cancel an event (host only)',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(eventSchema, 'Cancelled'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.cancel(c.get('user').id, c.req.valid('param').id), 200),
);

eventRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/register',
    tags: ['events'],
    summary: 'Register and receive a pass',
    description:
      'Idempotent: registering twice returns the existing pass. Closes at start + 1h or when ' +
      'capacity is reached.',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      201: jsonOk(registerResultSchema, 'Registered'),
      401: errorResponses[401],
      404: errorResponses[404],
      409: errorResponses[409],
      422: errorResponses[422],
    },
  }),
  async (c) => ok(c, await service.register(c.get('user').id, c.req.valid('param').id), 201),
);

eventRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}/register',
    tags: ['events'],
    summary: 'Cancel own registration',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(z.object({ cancelled: z.literal(true) }), 'Cancelled'),
      401: errorResponses[401],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.unregister(c.get('user').id, c.req.valid('param').id), 200),
);

eventRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/pass',
    tags: ['events'],
    summary: 'Own pass, including the code for the QR',
    description: "Only ever returns the caller's own pass. Cache it on device for offline display.",
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(passSchema, 'Pass'),
      401: errorResponses[401],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.myPass(c.get('user').id, c.req.valid('param').id), 200),
);

eventRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/participants',
    tags: ['events'],
    summary: 'Participant list (host and co-hosts only)',
    description: 'A participant list is personal data. Non-hosts get 403 — it is never public.',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(participantListSchema, 'Participants'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.participants(c.get('user').id, c.req.valid('param').id), 200),
);

eventRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/scan',
    tags: ['events'],
    summary: 'Check in a pass by its code (host and co-hosts only)',
    description: [
      'Seven ordered checks (PRD-v2 §6.6.4):',
      '1. caller is host or co-host  -> 403 EVENT_001',
      '2. pass exists for this event -> 404 EVENT_002',
      '3. now within [start-1h, end+2h] -> 422 EVENT_003',
      '4. not already checked in     -> 200 with alreadyCheckedIn: true, no second reward',
      '5. under capacity             -> 422 EVENT_005',
      '6. mark checked in + award the attendee, in one transaction',
      "7. flag for review when check-ins exceed 3x this host's median",
    ].join('\n'),
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: idParam,
      body: { content: { 'application/json': { schema: scanBodySchema } }, required: true },
    },
    responses: {
      200: jsonOk(scanResultSchema, 'Checked in, or already checked in'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      422: errorResponses[422],
      429: errorResponses[429],
    },
  }),
  async (c) =>
    ok(c, await service.scan(c.get('user').id, c.req.valid('param').id, c.req.valid('json')), 200),
);

eventRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/manual-check-in',
    tags: ['events'],
    summary: 'Check in by participant id — the web fallback for a host without the app',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: idParam,
      body: {
        content: {
          'application/json': { schema: z.object({ passId: z.number().int() }) },
        },
        required: true,
      },
    },
    responses: {
      200: jsonOk(scanResultSchema, 'Checked in'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      422: errorResponses[422],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.manualCheckIn(
        c.get('user').id,
        c.req.valid('param').id,
        c.req.valid('json').passId,
      ),
      200,
    ),
);

eventRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/co-hosts',
    tags: ['events'],
    summary: 'Add a co-host (host only). Co-hosts may scan but not edit or cancel.',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: idParam,
      body: { content: { 'application/json': { schema: coHostBodySchema } }, required: true },
    },
    responses: {
      200: jsonOk(eventSchema, 'Added'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.addCoHost(
        c.get('user').id,
        c.req.valid('param').id,
        c.req.valid('json').userId,
      ),
      200,
    ),
);

eventRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}/co-hosts/{userId}',
    tags: ['events'],
    summary: 'Remove a co-host (host only)',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: z.object({
        id: z.coerce
          .number()
          .int()
          .positive()
          .openapi({ param: { name: 'id', in: 'path' } }),
        userId: z.coerce
          .number()
          .int()
          .positive()
          .openapi({ param: { name: 'userId', in: 'path' } }),
      }),
    },
    responses: {
      200: jsonOk(eventSchema, 'Removed'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const { id, userId } = c.req.valid('param');
    return ok(c, await service.removeCoHost(c.get('user').id, id, userId), 200);
  },
);
