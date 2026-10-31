import { requireUser } from '@common/guards/auth.guard.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { errorResponses, jsonOk, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { cursorQuery, idParam, paginated } from '@common/openapi/params.ts';
import { createRoute, z } from '@hono/zod-openapi';
import {
  onboardingCompleteResultSchema,
  onboardingStateSchema,
  ownProfileSchema,
  publicProfileSchema,
  rewardEntrySchema,
  stepBodySchema,
  stepParam,
} from './profile.schema.ts';
import * as service from './profile.service.ts';

export const profileRoutes = createModule();

profileRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/onboarding',
    tags: ['profile'],
    summary: 'Partial onboarding answers, for resuming',
    description: 'Any device resumes where another left off — the wizard is server-persisted.',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(onboardingStateSchema, 'Current onboarding state'),
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.onboardingState(c.get('user').id), 200),
);

profileRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/onboarding/step/{n}',
    tags: ['profile'],
    summary: 'Persist one wizard step (1–5)',
    description:
      'Each step is its own request so a dropped connection never loses the whole form. ' +
      'v1 kept all 32 inputs in one DOM form and persisted nothing until final submit.',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: stepParam,
      body: { content: { 'application/json': { schema: stepBodySchema } }, required: true },
    },
    responses: {
      200: jsonOk(onboardingStateSchema, 'Step saved'),
      400: errorResponses[400],
      401: errorResponses[401],
    },
  }),
  async (c) => {
    const { n } = c.req.valid('param');
    return ok(c, await service.saveStep(c.get('user').id, n, c.req.valid('json')), 200);
  },
);

profileRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/onboarding/complete',
    tags: ['profile'],
    summary: 'Validate all 15 answers, compute the baseline, award the completion reward',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(onboardingCompleteResultSchema, 'Baseline computed'),
      401: errorResponses[401],
      409: errorResponses[409],
      422: errorResponses[422],
    },
  }),
  async (c) => ok(c, await service.completeOnboarding(c.get('user').id), 200),
);

profileRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['profile'],
    summary: 'Own profile',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(ownProfileSchema, 'Own profile'),
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.ownProfile(c.get('user').id), 200),
);

profileRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/',
    tags: ['profile'],
    summary: 'Edit lifestyle answers or settings',
    description:
      'Recomputes the baseline forward only. Past daily_footprints rows carry their own ' +
      'baseline snapshot, so history never changes retroactively (PRD-v2 §3.3).',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                name: z.string().min(1).max(80).optional(),
                timezone: z.string().optional(),
                avatarUrl: z.string().nullable().optional(),
                answers: onboardingStateSchema.shape.answers.optional(),
              })
              .openapi('ProfilePatchBody'),
          },
        },
      },
    },
    responses: {
      200: jsonOk(ownProfileSchema, 'Updated'),
      400: errorResponses[400],
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.patchProfile(c.get('user').id, c.req.valid('json')), 200),
);

profileRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/rewards',
    tags: ['profile'],
    summary: 'Points and coins ledger',
    middleware: [requireUser] as const,
    security: secured,
    request: { query: cursorQuery },
    responses: {
      200: jsonOk(paginated(rewardEntrySchema), 'Ledger page'),
      401: errorResponses[401],
    },
  }),
  async (c) => {
    const { cursor, limit } = c.req.valid('query');
    return ok(c, await service.rewards(c.get('user').id, limit, cursor), 200);
  },
);

profileRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/export',
    tags: ['profile'],
    summary: 'Full data export',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(z.record(z.string(), z.unknown()).openapi('DataExport'), 'Everything we hold'),
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.exportData(c.get('user').id), 200),
);

profileRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/',
    tags: ['profile'],
    summary: 'Delete account',
    description: 'Soft-deletes, anonymises PII, and hard-deletes uploads within 30 days.',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(z.object({ deleted: z.literal(true) }), 'Scheduled for deletion'),
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.deleteAccount(c.get('user').id), 200),
);

/** Mounted separately at /users — public, and never exposes a footprint. */
export const publicUserRoutes = createModule();

publicUserRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/{id}',
    tags: ['profile'],
    summary: "Another user's public profile",
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(publicProfileSchema, 'Public profile'),
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.publicProfile(c.req.valid('param').id), 200),
);
