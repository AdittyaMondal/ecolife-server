import { errorResponses, jsonOk, notImplemented, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { createRoute, type z } from '@hono/zod-openapi';
import {
  authResultSchema,
  forgotPasswordBodySchema,
  loginBodySchema,
  meSchema,
  okMessageSchema,
  refreshBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
  sessionSchema,
  verifyEmailBodySchema,
} from './auth.schema.ts';

export const authRoutes = createModule();

const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } }, required: true },
});

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/register',
    tags: ['auth'],
    summary: 'Create an account and start a session',
    description:
      'Rate limited to 10 per 15 minutes per IP and per email. Email verification is ' +
      'required before any reward can be earned (PRD-v2 §4.4).',
    request: body(registerBodySchema),
    responses: {
      201: jsonOk(authResultSchema, 'Account created'),
      400: errorResponses[400],
      409: errorResponses[409],
      429: errorResponses[429],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/login',
    tags: ['auth'],
    summary: 'Exchange credentials for a session',
    description: 'Failures are deliberately indistinguishable between unknown and wrong-password.',
    request: body(loginBodySchema),
    responses: {
      200: jsonOk(authResultSchema, 'Signed in'),
      401: errorResponses[401],
      429: errorResponses[429],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/refresh',
    tags: ['auth'],
    summary: 'Rotate the refresh token',
    description:
      'Accepts the token from the httpOnly cookie (web) or the body (mobile). Rotates on every ' +
      'use; a replayed token revokes the whole family.',
    request: { body: { content: { 'application/json': { schema: refreshBodySchema } } } },
    responses: {
      200: jsonOk(sessionSchema, 'Rotated'),
      401: errorResponses[401],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/logout',
    tags: ['auth'],
    summary: 'Revoke the current session family',
    security: secured,
    responses: { 200: jsonOk(okMessageSchema, 'Signed out'), 501: errorResponses[501] },
  }),
  notImplemented,
);

authRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/me',
    tags: ['auth'],
    summary: 'Current user, onboarding state and wallet',
    security: secured,
    responses: {
      200: jsonOk(meSchema, 'The authenticated user'),
      401: errorResponses[401],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/verify-email',
    tags: ['auth'],
    summary: 'Consume an email verification token',
    request: body(verifyEmailBodySchema),
    responses: {
      200: jsonOk(okMessageSchema, 'Verified'),
      422: errorResponses[422],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/resend-verification',
    tags: ['auth'],
    summary: 'Resend the verification email',
    security: secured,
    responses: {
      200: jsonOk(okMessageSchema, 'Sent'),
      429: errorResponses[429],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/forgot-password',
    tags: ['auth'],
    summary: 'Request a password reset link',
    description: 'Always 200, whether or not the address exists — it must not leak registration.',
    request: body(forgotPasswordBodySchema),
    responses: {
      200: jsonOk(okMessageSchema, 'Accepted'),
      429: errorResponses[429],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/reset-password',
    tags: ['auth'],
    summary: 'Set a new password from a reset token',
    description: 'Revokes every existing session for the user on success.',
    request: body(resetPasswordBodySchema),
    responses: {
      200: jsonOk(okMessageSchema, 'Password changed'),
      422: errorResponses[422],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);
