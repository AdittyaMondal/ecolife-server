import { DomainError } from '@common/errors/domain-error.ts';
import { requireUser } from '@common/guards/auth.guard.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import {
  assertNotLockedOut,
  BUCKETS,
  clientIp,
  consume,
  consumeFailedAttempt,
  consumeForIp,
} from '@common/middleware/rate-limit.ts';
import { errorResponses, jsonOk, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { env } from '@config/env.ts';
import { createRoute, type z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
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
import * as service from './auth.service.ts';

type Platform = 'web' | 'ios' | 'android';

/** Mobile says so explicitly; anything else is treated as a browser. */
const platformOf = (c: Context): Platform => {
  const p = c.req.header('x-ecolife-platform');
  return p === 'ios' || p === 'android' ? p : 'web';
};

const metaOf = (c: Context) => ({
  // clientIp returns null when no IP can be established; sessions stores it
  // nullable, so undefined is the right shape here.
  ip: clientIp(c) ?? undefined,
  userAgent: c.req.header('user-agent'),
  platform: platformOf(c),
});

/**
 * Web keeps the refresh token in an httpOnly cookie it cannot read from JS;
 * mobile gets it in the body for expo-secure-store. Returning it in the body
 * to a browser would hand any XSS a 30-day credential, so web gets null.
 */
function deliverRefresh(c: Context, token: string): string | null {
  if (platformOf(c) !== 'web') return token;
  setCookie(c, env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  });
  return null;
}

/** Accepts the token from the cookie (web) or the body (mobile). */
const presentedRefresh = (c: Context, body?: { refreshToken?: string }) =>
  body?.refreshToken ?? getCookie(c, env.SESSION_COOKIE_NAME) ?? null;

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
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    await consumeForIp(c, BUCKETS.authStrict);
    // Also per-email. Without it one address can be hammered from many hosts:
    // once verification mail is wired that is an email-bombing primitive, and
    // the 409 for an existing account makes it an enumeration loop today.
    await consume(`register:${body.email.toLowerCase()}`, BUCKETS.authStrict);

    const r = await service.register(body, metaOf(c));
    service.deliverEmailToken('verify', body.email, r.verificationToken);
    return ok(
      c,
      {
        session: {
          accessToken: r.accessToken,
          accessTokenExpiresIn: r.expiresIn,
          refreshToken: deliverRefresh(c, r.refreshToken),
        },
        user: service.publicUser(r.user, r.membership),
      },
      201,
    );
  },
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
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    // Per-IP on every attempt: one host spraying many accounts.
    await consumeForIp(c, BUCKETS.authStrict);

    // Then a read-only check of THIS attacker's bucket for THIS account,
    // before the password is verified. Charging only on failure is what stops
    // a stranger locking you out — but without this check nothing consults
    // those buckets at all, and where no client IP is available the per-IP
    // limiter skips, leaving guesses unlimited. Rejecting here even when the
    // password happens to be right is the point: a correct guess arrived at
    // by brute force is still brute force.
    await assertNotLockedOut(c, body.email, BUCKETS.authStrict);

    let r: Awaited<ReturnType<typeof service.login>>;
    try {
      r = await service.login(body.email, body.password, metaOf(c));
    } catch (err) {
      await consumeFailedAttempt(c, body.email, BUCKETS.authStrict);
      throw err;
    }
    return ok(
      c,
      {
        session: {
          accessToken: r.accessToken,
          accessTokenExpiresIn: r.expiresIn,
          refreshToken: deliverRefresh(c, r.refreshToken),
        },
        user: service.publicUser(r.user, r.membership),
      },
      200,
    );
  },
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
    },
  }),
  async (c) => {
    const presented = presentedRefresh(c, c.req.valid('json'));
    if (!presented) throw new DomainError('AUTH_003', 'No session to refresh.', 401);

    const r = await service.refresh(presented, metaOf(c));
    return ok(
      c,
      {
        accessToken: r.accessToken,
        accessTokenExpiresIn: r.expiresIn,
        refreshToken: deliverRefresh(c, r.refreshToken),
      },
      200,
    );
  },
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/logout',
    middleware: [requireUser] as const,
    tags: ['auth'],
    summary: 'Revoke the current session family',
    security: secured,
    responses: { 200: jsonOk(okMessageSchema, 'Signed out'), 501: errorResponses[501] },
  }),
  async (c) => {
    await service.logout(presentedRefresh(c));
    if (platformOf(c) === 'web') deleteCookie(c, env.SESSION_COOKIE_NAME, { path: '/' });
    return ok(c, { message: 'Signed out.' }, 200);
  },
);

authRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/me',
    middleware: [requireUser] as const,
    tags: ['auth'],
    summary: 'Current user, onboarding state and wallet',
    security: secured,
    responses: {
      200: jsonOk(meSchema, 'The authenticated user'),
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.me(c.get('user').id), 200),
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
    },
  }),
  async (c) => {
    await service.verifyEmail(c.req.valid('json').token);
    return ok(c, { message: 'Email verified.' }, 200);
  },
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/resend-verification',
    middleware: [requireUser] as const,
    tags: ['auth'],
    summary: 'Resend the verification email',
    security: secured,
    responses: {
      200: jsonOk(okMessageSchema, 'Sent'),
      429: errorResponses[429],
    },
  }),
  async (c) => {
    const user = c.get('user');
    await consume(`user:${user.id}`, BUCKETS.authStrict);
    const token = await service.resendVerification(user.id);
    service.deliverEmailToken('verify', String(user.id), token);
    return ok(c, { message: 'Verification email sent.' }, 200);
  },
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
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    await consumeForIp(c, BUCKETS.authStrict);
    const token = await service.forgotPassword(body.email);
    if (token) service.deliverEmailToken('reset', body.email, token);
    // Always the same answer. A 404 here is an account-existence oracle that
    // needs no password.
    return ok(c, { message: 'If that address exists, a link is on its way.' }, 200);
  },
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
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    await service.resetPassword(body.token, body.password);
    return ok(c, { message: 'Password changed. Please sign in again.' }, 200);
  },
);
