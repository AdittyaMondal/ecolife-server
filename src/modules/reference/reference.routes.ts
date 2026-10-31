import { errorResponses, jsonOk, notImplemented, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { cursorQuery, idParam, paginated } from '@common/openapi/params.ts';
import { createRoute, z } from '@hono/zod-openapi';
import {
  citySchema,
  methodologySchema,
  notificationSchema,
  presignBodySchema,
  presignResultSchema,
  regionSchema,
} from './reference.schema.ts';

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
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

referenceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/regions',
    tags: ['reference'],
    summary: 'Regions with their grid emission factor and tariff',
    responses: {
      200: jsonOk(z.object({ items: z.array(regionSchema) }), 'Regions'),
      501: errorResponses[501],
    },
  }),
  notImplemented,
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
      501: errorResponses[501],
    },
  }),
  notImplemented,
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
    responses: {
      200: jsonOk(presignResultSchema, 'Presigned'),
      400: errorResponses[400],
      401: errorResponses[401],
      429: errorResponses[429],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

export const notificationRoutes = createModule();

notificationRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['reference'],
    summary: 'In-app notifications',
    security: secured,
    request: { query: cursorQuery },
    responses: {
      200: jsonOk(paginated(notificationSchema), 'Notifications'),
      401: errorResponses[401],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

notificationRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}/read',
    tags: ['reference'],
    summary: 'Mark one notification read',
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(notificationSchema, 'Marked read'),
      401: errorResponses[401],
      404: errorResponses[404],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);
