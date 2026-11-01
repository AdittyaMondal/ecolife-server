import { requireAdmin, requireUser } from '@common/guards/auth.guard.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { BUCKETS, rateLimitByIp } from '@common/middleware/rate-limit.ts';
import { errorResponses, jsonOk, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { idParam, paginated } from '@common/openapi/params.ts';
import { createRoute, z } from '@hono/zod-openapi';
import {
  addMemberBodySchema,
  createOrganizationBodySchema,
  createOrgQuestionBodySchema,
  joinOrganizationBodySchema,
  joinResultSchema,
  leaveResultSchema,
  listMembersQuerySchema,
  lookupQuerySchema,
  lookupResultSchema,
  myOrganizationSchema,
  organizationAnalyticsSchema,
  organizationMemberListSchema,
  organizationQuerySchema,
  organizationSchema,
  orgEmployeeAnswersSchema,
  orgOnboardingStatusSchema,
  orgQuestionSchema,
  regenerateCodeResultSchema,
  reorderOrgQuestionsBodySchema,
  reviewOrganizationBodySchema,
  submitOrgOnboardingAnswersBodySchema,
  updateMembershipPreferencesBodySchema,
  updateMembershipPreferencesResultSchema,
  updateOrganizationBodySchema,
  updateOrgQuestionBodySchema,
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
    summary: 'Roster — any member may read it; insights filtered by privacy and role',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam, query: listMembersQuerySchema },
    responses: {
      200: jsonOk(organizationMemberListSchema, 'Members'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.members(c.get('user').id, c.req.valid('param').id, c.req.valid('query')),
      200,
    ),
);

organizationRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/analytics',
    tags: ['organizations'],
    summary: 'Cumulative organization carbon footprint analytics (owner only)',
    description:
      'Aggregated organization-level footprint: total emissions, per-month trend, category breakdown, and average per employee.',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(organizationAnalyticsSchema, 'Organization Analytics'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.analytics(c.get('user').id, c.req.valid('param').id), 200),
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
    summary: 'Remove another member (owner only)',
    description:
      'To remove yourself, use DELETE /organizations/me/membership — the answer differs, ' +
      'because someone who has just left cannot read the roster they are no longer on. ' +
      'The last owner cannot be removed either way.',
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

organizationRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/me/membership',
    tags: ['organizations'],
    summary: 'Leave your organization',
    description:
      'Anyone may leave, except the last owner. Members are ADDED by an owner rather than ' +
      'invited, so this is how someone who did not ask to be enrolled gets out — and since ' +
      'a person may belong to only one organization, being enrolled also blocks them from ' +
      'creating their own until they do.',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(leaveResultSchema, 'Left'),
      401: errorResponses[401],
      403: errorResponses[403],
      422: errorResponses[422],
    },
  }),
  async (c) => ok(c, await service.leave(c.get('user').id), 200),
);

organizationRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/me/membership',
    tags: ['organizations'],
    summary: 'Update membership preferences (e.g. carbon footprint privacy sharing)',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      body: {
        content: { 'application/json': { schema: updateMembershipPreferencesBodySchema } },
        required: true,
      },
    },
    responses: {
      200: jsonOk(updateMembershipPreferencesResultSchema, 'Preferences updated'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.updateMembershipPreferences(
        c.get('user').id,
        c.req.valid('json').shareFootprint,
      ),
      200,
    ),
);

organizationRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/lookup',
    tags: ['organizations'],
    summary: 'Validate organization code before signup',
    description:
      'Public endpoint to check if an organization code exists and is approved to accept members.',
    middleware: [rateLimitByIp(BUCKETS.search)] as const,
    request: { query: lookupQuerySchema },
    responses: {
      200: jsonOk(lookupResultSchema, 'Organization found and active'),
      400: errorResponses[400],
      403: errorResponses[403],
      404: errorResponses[404],
      429: errorResponses[429],
    },
  }),
  async (c) => ok(c, await service.lookupByCode(c.req.valid('query').code), 200),
);

organizationRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/me/code/regenerate',
    tags: ['organizations'],
    summary: 'Regenerate organization 6-digit code (owner only)',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(regenerateCodeResultSchema, 'New 6-digit code generated'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.regenerateCode(c.get('user').id), 200),
);

organizationRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/join',
    tags: ['organizations'],
    summary: 'Join an organization using its code or slug',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      body: {
        content: { 'application/json': { schema: joinOrganizationBodySchema } },
        required: true,
      },
    },
    responses: {
      200: jsonOk(joinResultSchema, 'Joined successfully'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: errorResponses[409],
    },
  }),
  async (c) => ok(c, await service.joinByCode(c.get('user').id, c.req.valid('json').code), 200),
);

organizationRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/questions',
    tags: ['organizations'],
    summary: 'List custom onboarding questions for an organization',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(z.array(orgQuestionSchema), 'Questions list'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.listQuestions(c.get('user').id, c.req.valid('param').id), 200),
);

organizationRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/questions',
    tags: ['organizations'],
    summary: 'Create a custom onboarding question (owner only)',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: idParam,
      body: {
        content: { 'application/json': { schema: createOrgQuestionBodySchema } },
        required: true,
      },
    },
    responses: {
      201: jsonOk(orgQuestionSchema, 'Question created'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.createQuestion(c.get('user').id, c.req.valid('param').id, c.req.valid('json')),
      201,
    ),
);

organizationRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/{id}/questions/{questionId}',
    tags: ['organizations'],
    summary: 'Update a custom onboarding question (owner only)',
    description:
      'Updating the prompt or type increments the question version so previous answers remain faithful snapshots.',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: z.object({
        id: z.coerce.number().int().positive().openapi({ example: 42 }),
        questionId: z.coerce.number().int().positive().openapi({ example: 1 }),
      }),
      body: {
        content: { 'application/json': { schema: updateOrgQuestionBodySchema } },
        required: true,
      },
    },
    responses: {
      200: jsonOk(orgQuestionSchema, 'Question updated'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.updateQuestion(
        c.get('user').id,
        c.req.valid('param').id,
        c.req.valid('param').questionId,
        c.req.valid('json'),
      ),
      200,
    ),
);

organizationRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/questions/reorder',
    tags: ['organizations'],
    summary: 'Reorder custom onboarding questions (owner only)',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: idParam,
      body: {
        content: { 'application/json': { schema: reorderOrgQuestionsBodySchema } },
        required: true,
      },
    },
    responses: {
      200: jsonOk(z.object({ ok: z.boolean().openapi({ example: true }) }), 'Reordered'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.reorderQuestions(
        c.get('user').id,
        c.req.valid('param').id,
        c.req.valid('json').questionIds,
      ),
      200,
    ),
);

organizationRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}/questions/{questionId}',
    tags: ['organizations'],
    summary: 'Delete (archive) a custom onboarding question (owner only)',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: z.object({
        id: z.coerce.number().int().positive().openapi({ example: 42 }),
        questionId: z.coerce.number().int().positive().openapi({ example: 1 }),
      }),
    },
    responses: {
      200: jsonOk(z.object({ ok: z.boolean().openapi({ example: true }) }), 'Deleted'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.deleteQuestion(
        c.get('user').id,
        c.req.valid('param').id,
        c.req.valid('param').questionId,
      ),
      200,
    ),
);

organizationRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/me/onboarding',
    tags: ['organizations'],
    summary: 'Get custom onboarding questions and current answers for the caller',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(orgOnboardingStatusSchema, 'Custom onboarding questions and answers'),
      401: errorResponses[401],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.getOnboardingQuestionsAndAnswers(c.get('user').id), 200),
);

organizationRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/me/onboarding',
    tags: ['organizations'],
    summary: 'Submit answers for custom onboarding questions',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      body: {
        content: { 'application/json': { schema: submitOrgOnboardingAnswersBodySchema } },
        required: true,
      },
    },
    responses: {
      200: jsonOk(
        z.object({
          ok: z.boolean().openapi({ example: true }),
          count: z.number().int().openapi({ example: 3 }),
        }),
        'Answers submitted',
      ),
      400: errorResponses[400],
      401: errorResponses[401],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(c, await service.submitOnboardingAnswers(c.get('user').id, c.req.valid('json')), 200),
);

organizationRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{id}/members/{userId}/answers',
    tags: ['organizations'],
    summary: "View a member's custom onboarding answers (owner only)",
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: z.object({
        id: z.coerce.number().int().positive().openapi({ example: 42 }),
        userId: z.coerce.number().int().positive().openapi({ example: 7 }),
      }),
    },
    responses: {
      200: jsonOk(orgEmployeeAnswersSchema, 'Member answers'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.getMemberAnswers(
        c.get('user').id,
        c.req.valid('param').id,
        c.req.valid('param').userId,
      ),
      200,
    ),
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
