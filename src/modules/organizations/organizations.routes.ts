import { requireAdmin, requireUser } from '@common/guards/auth.guard.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { errorResponses, jsonOk, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { idParam, paginated } from '@common/openapi/params.ts';
import { createRoute, z } from '@hono/zod-openapi';
import {
  addMemberBodySchema,
  createOrganizationBodySchema,
  myOrganizationSchema,
  organizationMemberListSchema,
  organizationQuerySchema,
  organizationSchema,
  reviewOrganizationBodySchema,
  updateOrganizationBodySchema,
} from './organizations.schema.ts';
import * as service from './organizations.service.ts';

/**
 * Partner organizations (PRD-v2 §6.9 role model).
 *
 * Two mounts, because the audiences are different: `/organizations` is the
 * owner's own portal, `/admin/organizations` is the review queue. Keeping
 * the admin surface on its own path makes "which routes need requireAdmin"
 * answerable by looking at the mount rather than at every handler.
 */
export const organizationRoutes = createModule();

organizationRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['organizations'],
    summary: 'Register an organization',
    description:
      'Creates it as `pending` and makes the caller its owner. It stays unusable until an ' +
      'admin approves it — anyone can claim to be a corporate partner at signup.',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      body: {
        content: { 'application/json': { schema: createOrganizationBodySchema } },
        required: true,
      },
    },
    responses: {
      201: jsonOk(organizationSchema, 'Created, pending review'),
      400: errorResponses[400],
      401: errorResponses[401],
      409: errorResponses[409],
    },
  }),
  async (c) => ok(c, await service.create(c.get('user').id, c.req.valid('json')), 201),
);

organizationRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/me',
    tags: ['organizations'],
    summary: "The caller's own organization, if any",
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(myOrganizationSchema, 'Own organization, or nulls'),
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.mine(c.get('user').id), 200),
);

organizationRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['organizations'],
    summary: 'Edit an organization (owner only)',
    description:
      '`type` and `status` are deliberately not editable: a seller must not re-badge itself ' +
      'as an NGO after approval, and nobody approves themselves.',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: idParam,
      body: { content: { 'application/json': { schema: updateOrganizationBodySchema } } },
    },
    responses: {
      200: jsonOk(organizationSchema, 'Updated'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: errorResponses[409],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.update(c.get('user').id, c.req.valid('param').id, c.req.valid('json')),
      200,
    ),
);

organizationRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/members',
    tags: ['organizations'],
    summary: 'Roster — any member may read it',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(organizationMemberListSchema, 'Members'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.members(c.get('user').id, c.req.valid('param').id), 200),
);

organizationRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/members',
    tags: ['organizations'],
    summary: 'Add a member by email (owner only)',
    description: 'The person must already have an account. One organization per user.',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: idParam,
      body: { content: { 'application/json': { schema: addMemberBodySchema } }, required: true },
    },
    responses: {
      200: jsonOk(organizationMemberListSchema, 'Members after the change'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: errorResponses[409],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.addMember(c.get('user').id, c.req.valid('param').id, c.req.valid('json')),
      200,
    ),
);

organizationRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}/members/{userId}',
    tags: ['organizations'],
    summary: 'Remove a member (owner only)',
    description: 'The last owner cannot be removed — that would orphan the organization.',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: z.object({
        id: z.coerce
          .number()
          .int()
          .positive()
          .openapi({ param: { name: 'id', in: 'path' }, example: 7 }),
        userId: z.coerce
          .number()
          .int()
          .positive()
          .openapi({ param: { name: 'userId', in: 'path' }, example: 9 }),
      }),
    },
    responses: {
      200: jsonOk(organizationMemberListSchema, 'Members after the change'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      422: errorResponses[422],
    },
  }),
  async (c) => {
    const { id, userId } = c.req.valid('param');
    return ok(c, await service.removeMember(c.get('user').id, id, userId), 200);
  },
);

/** Mounted at /admin/organizations. Every route here is staff-only. */
export const adminOrganizationRoutes = createModule();

adminOrganizationRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['organizations'],
    summary: 'Review queue (admin only)',
    description: 'Filter by `status=pending` for the queue. `reviewNote` is visible here only.',
    middleware: [requireUser, requireAdmin] as const,
    security: secured,
    request: { query: organizationQuerySchema },
    responses: {
      200: jsonOk(paginated(organizationSchema), 'Organizations'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.adminList(c.req.valid('query')), 200),
);

adminOrganizationRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/review',
    tags: ['organizations'],
    summary: 'Approve, reject, suspend or reinstate (admin only)',
    description:
      'A rejection or suspension requires a note — a decision a human has to defend later ' +
      'should be explained while they still remember why.',
    middleware: [requireUser, requireAdmin] as const,
    security: secured,
    request: {
      params: idParam,
      body: {
        content: { 'application/json': { schema: reviewOrganizationBodySchema } },
        required: true,
      },
    },
    responses: {
      200: jsonOk(organizationSchema, 'Reviewed'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      422: errorResponses[422],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.review(c.get('user').id, c.req.valid('param').id, c.req.valid('json')),
      200,
    ),
);
