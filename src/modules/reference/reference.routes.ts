import { requireUser } from '@common/guards/auth.guard.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { BUCKETS, rateLimitByIp } from '@common/middleware/rate-limit.ts';
import { errorResponses, jsonError, jsonOk, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { cursorQuery, idParam, paginated } from '@common/openapi/params.ts';
import { presignUpload } from '@common/storage/storage.ts';
import { createRoute, z } from '@hono/zod-openapi';
import {
  citySchema,
  methodologySchema,
  notificationSchema,
  presignBodySchema,
  presignResultSchema,
  regionSchema,
} from './reference.schema.ts';
import * as service from './reference.service.ts';

export const referenceRoutes = createModule();

referenceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/cities',
    tags: ['reference'],
    summary: 'City autocomplete for onboarding',
    request: {
      query: z.object({
        q: z
          .string()
          .min(1)
          .openapi({ param: { name: 'q', in: 'query' }, example: 'mum' }),
      }),
    },
    responses: {
      200: jsonOk(z.object({ items: z.array(citySchema) }), 'Matching cities'),
      400: errorResponses[400],
    },
  }),
  async (c) => ok(c, { items: await service.searchCities(c.req.valid('query').q) }, 200),
);

referenceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/regions',
    tags: ['reference'],
    summary: 'Regions with their grid emission factor and tariff',
    responses: {
      200: jsonOk(z.object({ items: z.array(regionSchema) }), 'Regions'),
    },
  }),
  async (c) => ok(c, { items: await service.listRegions() }, 200),
);

export const carbonRoutes = createModule();

carbonRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/methodology',
    tags: ['carbon'],
    summary: 'Every emission factor, with its source — public',
    description: 'Rendered at /methodology on web. No auth: it is the credibility surface.',
    responses: {
      200: jsonOk(methodologySchema, 'Factor table'),
    },
  }),
  (c) => ok(c, service.methodology(), 200),
);

export const uploadRoutes = createModule();

uploadRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/presign',
    tags: ['reference'],
    summary: 'Presigned PUT for a direct-to-storage upload',
    description:
      'Images never transit the API. The server verifies magic bytes and strips EXIF ' +
      'asynchronously after upload.',
    security: secured,
    request: {
      body: { content: { 'application/json': { schema: presignBodySchema } }, required: true },
    },
    middleware: [requireUser, rateLimitByIp(BUCKETS.write)] as const,
    responses: {
      200: jsonOk(presignResultSchema, 'Presigned'),
      400: errorResponses[400],
      401: errorResponses[401],
      429: errorResponses[429],
      503: jsonError('Uploads are not configured on this server'),
    },
  }),
  async (c) =>
    ok(c, await presignUpload({ userId: c.get('user').id, ...c.req.valid('json') }), 200),
);

export const notificationRoutes = createModule();

notificationRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['reference'],
    summary: 'In-app notifications',
    middleware: [requireUser] as const,
    security: secured,
    request: { query: cursorQuery },
    responses: {
      200: jsonOk(paginated(notificationSchema), 'Notifications'),
      400: errorResponses[400],
      401: errorResponses[401],
    },
  }),
  async (c) => {
    const { cursor, limit } = c.req.valid('query');
    return ok(c, await service.listNotifications(c.get('user').id, limit, cursor), 200);
  },
);

notificationRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}/read',
    tags: ['reference'],
    summary: 'Mark one notification read',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(notificationSchema, 'Marked read'),
      401: errorResponses[401],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.markRead(c.get('user').id, c.req.valid('param').id), 200),
);
