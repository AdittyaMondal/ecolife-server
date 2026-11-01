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
    code: z.string().openapi({ example: '482910' }),
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
    verificationDetails: z.record(z.string(), z.unknown()).nullable().optional(),
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
    verificationDetails: z.record(z.string(), z.unknown()).optional(),
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
    email: z.string().email().optional().openapi({ example: 'colleague@acme.example.com' }),
    role: orgMemberRoleSchema,
    joinedAt: z.string().openapi({ example: '2026-11-01T09:00:00.000Z' }),
    shareFootprint: z.boolean().default(true).openapi({ example: true }),
    onboardingStatus: z.enum(['completed', 'pending']).openapi({ example: 'completed' }),
    pointsTotal: z.number().int().optional().openapi({ example: 450 }),
    currentStreak: z.number().int().optional().openapi({ example: 5 }),
    baselineTotalKg: z.number().nullable().optional().openapi({ example: 6.8 }),
    last30DaysTotalKg: z.number().nullable().optional().openapi({ example: 142.5 }),
    avgDailyKg: z.number().nullable().optional().openapi({ example: 4.75 }),
    reductionPct: z.number().nullable().optional().openapi({ example: 12.5 }),
    lastActiveAt: z.string().nullable().optional().openapi({ example: '2026-10-31T18:30:00.000Z' }),
  })
  .openapi('OrganizationMember');

export const listMembersQuerySchema = z.object({
  search: z.string().optional().openapi({ example: 'Alice' }),
  role: orgMemberRoleSchema.optional().openapi({ example: 'member' }),
  onboardingStatus: z.enum(['completed', 'pending']).optional().openapi({ example: 'completed' }),
});

export const updateMembershipPreferencesBodySchema = z
  .object({
    shareFootprint: z.boolean().openapi({ example: true }),
  })
  .openapi('UpdateMembershipPreferencesBody');

export const updateMembershipPreferencesResultSchema = z
  .object({
    updated: z.literal(true),
    shareFootprint: z.boolean(),
  })
  .openapi('UpdateMembershipPreferencesResult');

export const orgCategoryBreakdownSchema = z
  .object({
    transportKg: z.number().openapi({ example: 450.2 }),
    foodKg: z.number().openapi({ example: 320.5 }),
    homeEnergyKg: z.number().openapi({ example: 510.0 }),
    waterKg: z.number().openapi({ example: 95.8 }),
    wasteKg: z.number().openapi({ example: 64.1 }),
    transportPct: z.number().openapi({ example: 31.3 }),
    foodPct: z.number().openapi({ example: 22.2 }),
    homeEnergyPct: z.number().openapi({ example: 35.4 }),
    waterPct: z.number().openapi({ example: 6.7 }),
    wastePct: z.number().openapi({ example: 4.4 }),
  })
  .openapi('OrgCategoryBreakdown');

export const orgMonthlyTrendItemSchema = z
  .object({
    month: z.string().openapi({ example: '2026-10' }),
    totalKg: z.number().openapi({ example: 1240.5 }),
    avgPerEmployeeKg: z.number().openapi({ example: 62.0 }),
    activeLoggers: z.number().int().openapi({ example: 20 }),
  })
  .openapi('OrgMonthlyTrendItem');

export const organizationAnalyticsSchema = z
  .object({
    organizationId: z.number().int(),
    totalFootprintKg: z.number().openapi({ example: 1440.6 }),
    annualProjectedTonnes: z.number().openapi({ example: 17.5 }),
    totalMembers: z.number().int().openapi({ example: 25 }),
    activeLoggers: z.number().int().openapi({ example: 18 }),
    avgPerEmployeeKg: z.number().openapi({ example: 57.6 }),
    dailyPerCapitaKg: z.number().openapi({ example: 5.8 }),
    urbanBenchmarkDailyKg: z.number().openapi({ example: 7.2 }),
    reductionVsUrbanPct: z.number().openapi({ example: 19.4 }),
    categories: orgCategoryBreakdownSchema,
    monthlyTrend: z.array(orgMonthlyTrendItemSchema),
  })
  .openapi('OrganizationAnalytics');

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

export const lookupQuerySchema = z.object({
  code: z.string().min(1).max(20).openapi({ param: { name: 'code', in: 'query' }, example: '482910' }),
});

export const lookupResultSchema = z
  .object({
    valid: z.boolean().openapi({ example: true }),
    name: z.string().openapi({ example: 'Acme Industries' }),
    type: organizationTypeSchema,
    slug: z.string().openapi({ example: 'acme-industries' }),
    code: z.string().openapi({ example: '482910' }),
  })
  .openapi('OrganizationLookupResult');

export const regenerateCodeResultSchema = z
  .object({
    code: z.string().length(6).openapi({ example: '719302' }),
    organization: organizationSchema,
  })
  .openapi('RegenerateCodeResult');

// --- Part 4: Custom Onboarding Questions -----------------------------------

export const orgQuestionTypeSchema = z
  .enum(['text', 'single_choice', 'multiple_choice', 'number', 'yes_no'])
  .openapi('OrgQuestionType');

export const orgQuestionSchema = z
  .object({
    id: z.number().int().openapi({ example: 1 }),
    organizationId: z.number().int().openapi({ example: 42 }),
    prompt: z.string().min(1).max(300).openapi({ example: 'What department do you work in?' }),
    description: z.string().nullable().optional().openapi({ example: 'Used for team impact reports' }),
    type: orgQuestionTypeSchema,
    options: z.array(z.string()).nullable().optional().openapi({ example: ['Engineering', 'Sales', 'Design'] }),
    required: z.boolean().openapi({ example: true }),
    sortOrder: z.number().int().openapi({ example: 0 }),
    version: z.number().int().openapi({ example: 1 }),
    active: z.boolean().openapi({ example: true }),
    createdAt: z.string().openapi({ example: '2026-11-01T00:00:00.000Z' }),
    updatedAt: z.string().openapi({ example: '2026-11-01T00:00:00.000Z' }),
  })
  .openapi('OrgOnboardingQuestion');

export const createOrgQuestionBodySchema = z
  .object({
    prompt: z.string().min(1).max(300).openapi({ example: 'What department do you work in?' }),
    description: z.string().max(500).optional().openapi({ example: 'Used for team impact reports' }),
    type: orgQuestionTypeSchema,
    options: z.array(z.string().min(1).max(120)).optional().openapi({ example: ['Engineering', 'Sales', 'Design'] }),
    required: z.boolean().default(false).openapi({ example: false }),
  })
  .openapi('CreateOrgQuestionBody');

export const updateOrgQuestionBodySchema = z
  .object({
    prompt: z.string().min(1).max(300).optional(),
    description: z.string().max(500).nullable().optional(),
    type: orgQuestionTypeSchema.optional(),
    options: z.array(z.string().min(1).max(120)).nullable().optional(),
    required: z.boolean().optional(),
  })
  .openapi('UpdateOrgQuestionBody');

export const reorderOrgQuestionsBodySchema = z
  .object({
    questionIds: z.array(z.number().int()).min(1).openapi({ example: [3, 1, 2] }),
  })
  .openapi('ReorderOrgQuestionsBody');

export const orgAnswerInputSchema = z
  .object({
    questionId: z.number().int().openapi({ example: 1 }),
    answer: z.unknown().openapi({ example: 'Engineering' }),
  })
  .openapi('OrgAnswerInput');

export const submitOrgOnboardingAnswersBodySchema = z
  .object({
    answers: z.array(orgAnswerInputSchema),
  })
  .openapi('SubmitOrgOnboardingAnswersBody');

export const orgAnswerItemSchema = z
  .object({
    id: z.number().int().openapi({ example: 10 }),
    questionId: z.number().int().openapi({ example: 1 }),
    questionPrompt: z.string().openapi({ example: 'What department do you work in?' }),
    questionType: z.string().openapi({ example: 'single_choice' }),
    questionVersion: z.number().int().openapi({ example: 1 }),
    answer: z.unknown().openapi({ example: 'Engineering' }),
    answeredAt: z.string().openapi({ example: '2026-11-01T00:00:00.000Z' }),
  })
  .openapi('OrgAnswerItem');

export const orgEmployeeAnswersSchema = z
  .object({
    userId: z.number().int().openapi({ example: 7 }),
    organizationId: z.number().int().openapi({ example: 42 }),
    answers: z.array(orgAnswerItemSchema),
  })
  .openapi('OrgEmployeeAnswers');

export const orgOnboardingStatusSchema = z
  .object({
    organization: organizationSchema,
    questions: z.array(orgQuestionSchema),
    answers: z.array(orgAnswerItemSchema),
    isCompleted: z.boolean().openapi({ example: true }),
  })
  .openapi('OrgOnboardingStatus');
