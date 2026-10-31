import { nullable } from '@common/openapi/envelope.ts';
import { externalImageUrlSchema, userSummarySchema } from '@common/openapi/shared-schemas.ts';
import { z } from '@hono/zod-openapi';

/**
 * Partner organizations (PRD-v2 §6.9 role model).
 *
 * Three types, one portal each in the clients — Corporate, Community and
 * Seller. The type is data; the portal is routing, and lives in the client.
 *
 * `[LESSON]` An organization is NOT usable until an admin approves it.
 * Anyone can claim to be a corporate partner at signup; nobody gets a portal
 * that can list products or host official drives until a human says so.
 */

/**
 * `z.string().url()` accepts `javascript:` and `data:text/html,...`. An
 * organization's website is rendered as a link in a partner directory, so
 * an unrestricted scheme is a stored XSS vector aimed at everyone browsing
 * it. Same reasoning as `externalImageUrlSchema`.
 */
const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), { message: 'must be an https URL' });

export const organizationTypeSchema = z
  .enum(['industry', 'ngo', 'seller'])
  .openapi({ example: 'industry', description: 'Corporate · Community · Seller portal' });

export const organizationStatusSchema = z
  .enum(['pending', 'approved', 'rejected', 'suspended'])
  .openapi({ example: 'pending' });

export const orgMemberRoleSchema = z.enum(['owner', 'member']).openapi({ example: 'owner' });

export const organizationSchema = z
  .object({
    id: z.number().int().openapi({ example: 7 }),
    slug: z.string().openapi({ example: 'acme-industries' }),
    name: z.string().openapi({ example: 'Acme Industries' }),
    type: organizationTypeSchema,
    status: organizationStatusSchema,
    description: z.string().nullable().openapi({ example: 'Packaging, 400 staff in Pune.' }),
    logoUrl: z.string().nullable(),
    websiteUrl: z.string().nullable().openapi({ example: 'https://acme.example.com' }),
    contactEmail: z.string().nullable().openapi({ example: 'green@acme.example.com' }),
    contactPhone: z.string().nullable().openapi({ example: '+912012345678' }),
    city: z.string().nullable().openapi({ example: 'Pune' }),
    regionCode: z.string().nullable().openapi({ example: 'IN-MH' }),
    memberCount: z.number().int().openapi({ example: 12 }),
    /** Only ever populated for an admin. A rejection note is not for the applicant. */
    reviewNote: z.string().nullable().openapi({ example: null }),
    reviewedAt: z.string().nullable().openapi({ example: null }),
    createdAt: z.string().openapi({ example: '2026-11-01T09:00:00.000Z' }),
  })
  .openapi('Organization');

export const createOrganizationBodySchema = z
  .object({
    name: z.string().min(2).max(120).openapi({ example: 'Acme Industries' }),
    type: organizationTypeSchema,
    description: z.string().max(2000).optional(),
    websiteUrl: httpsUrl.max(300).optional(),
    contactEmail: z.string().email().max(160).optional(),
    contactPhone: z.string().max(32).optional(),
    city: z.string().max(80).optional(),
    regionCode: z.string().max(10).optional(),
  })
  .openapi('CreateOrganizationBody');

/** Everything an owner may change. Type and status are deliberately absent. */
export const updateOrganizationBodySchema = createOrganizationBodySchema
  .omit({ type: true })
  .partial()
  .extend({ logoUrl: externalImageUrlSchema.nullable().optional() })
  .openapi('UpdateOrganizationBody');

export const organizationMemberSchema = z
  .object({
    user: userSummarySchema,
    role: orgMemberRoleSchema,
    joinedAt: z.string().openapi({ example: '2026-11-01T09:00:00.000Z' }),
    pointsTotal: z.number().int().optional().openapi({ example: 450 }),
    baselineTotalKg: z.number().nullable().optional().openapi({ example: 6.8 }),
  })
  .openapi('OrganizationMember');

export const organizationMemberListSchema = z
  .object({
    organization: organizationSchema,
    items: z.array(organizationMemberSchema),
  })
  .openapi('OrganizationMemberList');

export const joinOrganizationBodySchema = z
  .object({
    code: z.string().min(1).max(120).openapi({
      example: 'acme-industries',
      description: 'Organization code or slug',
    }),
  })
  .openapi('JoinOrganizationBody');

export const joinResultSchema = z
  .object({
    joined: z.literal(true),
    organization: organizationSchema,
    role: orgMemberRoleSchema,
  })
  .openapi('JoinOrganizationResult');

export const addMemberBodySchema = z
  .object({
    email: z.string().email().openapi({
      example: 'colleague@acme.example.com',
      description: 'Must already have an account',
    }),
    role: orgMemberRoleSchema.default('member'),
  })
  .openapi('AddOrganizationMemberBody');

export const leaveResultSchema = z
  .object({ left: z.literal(true) })
  .openapi('LeaveOrganizationResult');

/**
 * The admin decision.
 *
 * `note` is required on a rejection and a suspension: a status change a
 * human has to explain later should be explained now, while they still
 * remember why.
 */
export const reviewOrganizationBodySchema = z
  .object({
    decision: z.enum(['approve', 'reject', 'suspend', 'reinstate']).openapi({ example: 'approve' }),
    note: z.string().max(1000).optional().openapi({ example: 'GST certificate checked.' }),
    /**
     * The name the admin is looking at, echoed back.
     *
     * Required, and not optional-with-a-fallback, because an optional
     * safety check is one the client eventually stops sending. It closes
     * the window between opening the review queue and clicking approve: an
     * owner who renames in between would otherwise have a name the admin
     * never saw stamped with that admin's approval.
     */
    expected: z
      .object({
        name: z.string().min(1).max(120).openapi({ example: 'Acme Industries' }),
        logoUrl: z.string().nullable().openapi({ example: null }),
        websiteUrl: z.string().nullable().openapi({ example: 'https://acme.example.com' }),
      })
      .openapi({
        description:
          'The identity fields exactly as the review queue showed them. Compared inside the ' +
          'UPDATE, so an edit landing mid-decision is refused rather than approved unseen.',
      }),
  })
  .openapi('ReviewOrganizationBody');

export const organizationQuerySchema = z.object({
  status: organizationStatusSchema.optional().openapi({ param: { name: 'status', in: 'query' } }),
  type: organizationTypeSchema.optional().openapi({ param: { name: 'type', in: 'query' } }),
  cursor: z
    .string()
    .optional()
    .openapi({ param: { name: 'cursor', in: 'query' } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .openapi({ param: { name: 'limit', in: 'query' } }),
});

export const myOrganizationSchema = z
  .object({
    organization: nullable(organizationSchema),
    role: nullable(orgMemberRoleSchema),
  })
  .openapi('MyOrganization');
