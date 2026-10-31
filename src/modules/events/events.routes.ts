import { errorResponses, jsonOk, notImplemented, secured } from '@common/openapi/envelope.ts';
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

export const eventRoutes = createModule();

eventRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['events'],
    summary: 'Discover events',
    description: 'The `nearby` filter requires lat/lng and ranks by Haversine distance in SQL.',
    security: secured,
    request: { query: eventListQuerySchema },
    responses: {
      200: jsonOk(paginated(eventSchema), 'Events'),
      400: errorResponses[400],
      401: errorResponses[401],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

eventRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['events'],
    summary: 'Create an event — the creator becomes its host',
    security: secured,
    request: {
      body: { content: { 'application/json': { schema: createEventBodySchema } }, required: true },
    },
    responses: {
      201: jsonOk(eventSchema, 'Created'),
      400: errorResponses[400],
      401: errorResponses[401],
      422: errorResponses[422],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

eventRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{slug}',
    tags: ['events'],
    summary: 'Event detail with viewer-relative state',
    security: secured,
    request: { params: slugParam },
    responses: {
      200: jsonOk(eventSchema, 'Event'),
      403: errorResponses[403],
      404: errorResponses[404],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

eventRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['events'],
    summary: 'Edit an event (host only)',
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
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

eventRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/cancel',
    tags: ['events'],
    summary: 'Cancel an event (host only)',
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(eventSchema, 'Cancelled'),
      401: errorResponses[401],
      403: errorResponses[403],
      501: errorResponses[501],
    },
  }),
  notImplemented,
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
    security: secured,
    request: { params: idParam },
    responses: {
      201: jsonOk(registerResultSchema, 'Registered'),
      401: errorResponses[401],
      404: errorResponses[404],
      409: errorResponses[409],
      422: errorResponses[422],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

eventRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}/register',
    tags: ['events'],
    summary: 'Cancel own registration',
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(z.object({ cancelled: z.literal(true) }), 'Cancelled'),
      401: errorResponses[401],
      404: errorResponses[404],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

eventRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/pass',
    tags: ['events'],
    summary: 'Own pass, including the code for the QR',
    description: "Only ever returns the caller's own pass. Cache it on device for offline display.",
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(passSchema, 'Pass'),
      401: errorResponses[401],
      404: errorResponses[404],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

eventRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/participants',
    tags: ['events'],
    summary: 'Participant list (host and co-hosts only)',
    description: 'A participant list is personal data. Non-hosts get 403 — it is never public.',
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(participantListSchema, 'Participants'),
      401: errorResponses[401],
      403: errorResponses[403],
      501: errorResponses[501],
    },
  }),
  notImplemented,
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
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

eventRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/manual-check-in',
    tags: ['events'],
    summary: 'Check in by participant id — the web fallback for a host without the app',
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
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

eventRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/co-hosts',
    tags: ['events'],
    summary: 'Add a co-host (host only). Co-hosts may scan but not edit or cancel.',
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
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

eventRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}/co-hosts/{userId}',
    tags: ['events'],
    summary: 'Remove a co-host (host only)',
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
      501: errorResponses[501],
    },
  }),
  notImplemented,
);
