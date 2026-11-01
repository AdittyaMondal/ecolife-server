import { nullable } from '@common/openapi/envelope.ts';
import { walletSchema } from '@common/openapi/shared-schemas.ts';
import { z } from '@hono/zod-openapi';

/** PRD-v2 §6.1. Two clients, two token transports, one endpoint set. */

export const emailSchema = z.string().email().max(254).openapi({ example: 'yusuf@example.com' });

/**
 * Minimum 10 characters rather than the usual 8, and no composition rules.
 * Length beats character classes, and a rule the user works around with
 * "Password1!" buys nothing.
 */
export const passwordSchema = z
  .string()
  .min(10)
  .max(200)
  .openapi({ example: 'correct horse battery' });

export const registerBodySchema = z
  .object({
    name: z.string().min(1).max(80).openapi({ example: 'Yusuf' }),
    email: emailSchema,
    password: passwordSchema,
    phone: z.string().min(8).max(20).optional().openapi({ example: '+919876543210' }),
    timezone: z.string().default('Asia/Kolkata').openapi({ example: 'Asia/Kolkata' }),
    organizationCode: z
      .string()
      .trim()
      .min(6)
      .max(20)
      .optional()
      .openapi({ example: '482910', description: 'Optional 6-digit organization code to link user upon signup' }),
  })
  .openapi('RegisterBody');

export const loginBodySchema = z
  .object({ email: emailSchema, password: passwordSchema })
  .openapi('LoginBody');

/**
 * The refresh token is returned in the body for the mobile client, which stores
 * it in expo-secure-store, AND set as an httpOnly cookie for the web client.
 * Web ignores the body value; mobile ignores the cookie.
 */
export const sessionSchema = z
  .object({
    accessToken: z.string().openapi({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }),
    accessTokenExpiresIn: z.number().int().openapi({ example: 900, description: 'seconds' }),
    refreshToken: z
      .string()
      .nullable()
      .openapi({
        example: null,
        description:
          'Non-null ONLY when the request carried `x-ecolife-platform: ios` or `android`. ' +
          'Without that header the caller is treated as a browser: the token is set as an ' +
          'httpOnly cookie and this field is null. It is not a bug — returning a 30-day ' +
          'credential where JS can read it would hand any XSS the whole account.',
      }),
  })
  .openapi('Session');

export const meSchema = z
  .object({
    id: z.number().int().openapi({ example: 7 }),
    name: z.string().openapi({ example: 'Yusuf' }),
    email: emailSchema,
    role: z.enum(['user', 'admin']).openapi({ example: 'user' }),
    avatarUrl: z.string().nullable().openapi({ example: null }),
    city: z.string().nullable().openapi({ example: 'Mumbai' }),
    timezone: z.string().openapi({ example: 'Asia/Kolkata' }),
    emailVerified: z
      .boolean()
      .openapi({ example: true, description: 'False blocks every reward (PRD-v2 §4.4)' }),
    onboardingComplete: z.boolean().openapi({ example: true }),
    completedSteps: z.number().int().min(0).max(5).openapi({ example: 5 }),
    wallet: walletSchema,
    unreadNotifications: z.number().int().openapi({ example: 2 }),
    /**
     * Null for an ordinary user. Clients route to the Corporate, Community or
     * Seller portal off `type`, and MUST treat any status other than
     * 'approved' as read-only — an unapproved organization is a claim, not a
     * credential.
     */
    organization: nullable(
      z
        .object({
          id: z.number().int().openapi({ example: 12 }),
          slug: z.string().openapi({ example: 'acme-industries' }),
          code: z.string().openapi({ example: '482910' }),
          name: z.string().openapi({ example: 'Acme Industries' }),
          type: z.enum(['industry', 'ngo', 'seller']).openapi({ example: 'industry' }),
          status: z
            .enum(['pending', 'approved', 'rejected', 'suspended'])
            .openapi({ example: 'approved' }),
          role: z.enum(['owner', 'member']).openapi({ example: 'owner' }),
        })
        .openapi('MemberOrganization'),
    ),
  })
  .openapi('Me');

export const authResultSchema = z
  .object({ session: sessionSchema, user: meSchema })
  .openapi('AuthResult');

export const refreshBodySchema = z
  .object({
    refreshToken: z
      .string()
      .optional()
      .openapi({ description: 'Mobile sends this. Web sends the httpOnly cookie instead.' }),
  })
  .openapi('RefreshBody');

export const verifyEmailBodySchema = z
  .object({ token: z.string().min(1).openapi({ example: 'a1b2c3…' }) })
  .openapi('VerifyEmailBody');

export const forgotPasswordBodySchema = z
  .object({ email: emailSchema })
  .openapi('ForgotPasswordBody');

export const resetPasswordBodySchema = z
  .object({ token: z.string().min(1), password: passwordSchema })
  .openapi('ResetPasswordBody');

export const okMessageSchema = z
  .object({
    message: z.string().openapi({ example: 'If that address exists, a link is on its way.' }),
  })
  .openapi('OkMessage');
