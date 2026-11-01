import type { Executor } from '@common/rewards/rewards.ts';
import { db } from '@database/client.ts';
import {
  dailyFootprints,
  lifestyleProfiles,
  organizationMembers,
  organizationOnboardingAnswers,
  organizationOnboardingQuestions,
  organizations,
  users,
} from '@database/schema/index.ts';
import { and, asc, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';

/** Every Drizzle query for the organizations module. */

export type OrgRow = typeof organizations.$inferSelect;

/**
 * `member_count` is derived, never stored — a stale counter is a lie.
 *
 * The outer column is written out in full rather than interpolated as
 * `${organizations.id}`. Drizzle renders a bare column reference as `"id"`
 * with no table qualifier, and `organization_members` has an `id` of its
 * own — so inside this subquery `"id"` binds to the MEMBER's id and the
 * predicate becomes `m.organization_id = m.id`. That is false for almost
 * every row, so the count came back 0 and looked like an empty
 * organization rather than a broken query.
 */
const memberCount = sql<number>`(
  select count(*)::int from ${organizationMembers} m
   where m.organization_id = ${sql.raw('"organizations"."id"')}
)`;

const ORG_COLUMNS = {
  id: organizations.id,
  slug: organizations.slug,
  code: organizations.code,
  name: organizations.name,
  type: organizations.type,
  status: organizations.status,
  description: organizations.description,
  logoUrl: organizations.logoUrl,
  websiteUrl: organizations.websiteUrl,
  contactEmail: organizations.contactEmail,
  contactPhone: organizations.contactPhone,
  city: organizations.city,
  regionCode: organizations.regionCode,
  reviewNote: organizations.reviewNote,
  verificationDetails: organizations.verificationDetails,
  reviewedAt: organizations.reviewedAt,
  createdAt: organizations.createdAt,
  memberCount,
} as const;

export async function findById(id: number, tx: Executor = db) {
  const [row] = await tx.select(ORG_COLUMNS).from(organizations).where(eq(organizations.id, id));
  return row ?? null;
}

/** The caller's organization and their role in it, or null for neither. */
export async function findMembership(userId: number, tx: Executor = db) {
  const [row] = await tx
    .select({ ...ORG_COLUMNS, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, userId));
  return row ?? null;
}

export async function findMemberRole(organizationId: number, userId: number, tx: Executor = db) {
  const [row] = await tx
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    );
  return row?.role ?? null;
}

export async function codeTaken(code: string, tx: Executor = db): Promise<boolean> {
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.code, code.trim()));
  return Boolean(row);
}

export async function updateCode(id: number, code: string, tx: Executor = db) {
  const [row] = await tx
    .update(organizations)
    .set({ code: code.trim(), updatedAt: new Date() })
    .where(eq(organizations.id, id))
    .returning(ORG_COLUMNS);
  return row ?? null;
}

export async function findByCode(code: string, tx: Executor = db) {
  const trimmed = code.trim();

  // 1. Check exact match on 6-digit organization code
  const [byCode] = await tx.select(ORG_COLUMNS).from(organizations).where(eq(organizations.code, trimmed));
  if (byCode) return byCode;

  // 2. Check slug match
  const [bySlug] = await tx
    .select(ORG_COLUMNS)
    .from(organizations)
    .where(sql`lower(${organizations.slug}) = ${trimmed.toLowerCase()}`);
  if (bySlug) return bySlug;

  // 3. Fallback to numeric id
  const asId = Number.parseInt(trimmed, 10);
  if (Number.isInteger(asId) && String(asId) === trimmed) {
    const byId = await findById(asId, tx);
    if (byId) return byId;
  }

  return null;
}

export function listMembers(
  organizationId: number,
  filters: {
    search?: string;
    role?: 'owner' | 'member';
    onboardingStatus?: 'completed' | 'pending';
  } = {},
) {
  const last30DaysSql = sql<number>`(
    select coalesce(sum(df.total_kg), 0)::float
    from daily_footprints df
    where df.user_id = ${users.id}
      and df.log_date >= (current_date - interval '30 days')
  )`;

  const avgDailySql = sql<number>`(
    select coalesce(avg(df.total_kg), 0)::float
    from daily_footprints df
    where df.user_id = ${users.id}
      and df.log_date >= (current_date - interval '30 days')
  )`;

  const reductionPctSql = sql<number>`(
    select coalesce(avg(df.reduction_pct), 0)::float
    from daily_footprints df
    where df.user_id = ${users.id}
      and df.log_date >= (current_date - interval '30 days')
  )`;

  const lastActiveSql = sql<string | null>`(
    select max(df.log_date)::text
    from daily_footprints df
    where df.user_id = ${users.id}
  )`;

  const conditions = [eq(organizationMembers.organizationId, organizationId)];

  if (filters.search) {
    const pattern = `%${filters.search.trim().toLowerCase()}%`;
    conditions.push(
      sql`(lower(${users.name}) like ${pattern} or lower(${users.email}) like ${pattern})`,
    );
  }

  if (filters.role) {
    conditions.push(eq(organizationMembers.role, filters.role));
  }

  if (filters.onboardingStatus === 'completed') {
    conditions.push(isNotNull(users.onboardedAt));
  } else if (filters.onboardingStatus === 'pending') {
    conditions.push(isNull(users.onboardedAt));
  }

  return (
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
        city: users.city,
        pointsTotal: users.pointsTotal,
        currentStreak: users.currentStreak,
        onboardedAt: users.onboardedAt,
        role: organizationMembers.role,
        shareFootprint: organizationMembers.shareFootprint,
        joinedAt: organizationMembers.joinedAt,
        baselineTotalKg: lifestyleProfiles.baselineTotalKg,
        last30DaysTotalKg: last30DaysSql,
        avgDailyKg: avgDailySql,
        reductionPct: reductionPctSql,
        lastActiveAt: lastActiveSql,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(lifestyleProfiles, eq(lifestyleProfiles.userId, users.id))
      .where(and(...conditions))
      // Owners first, then oldest member first — the list reads as a hierarchy.
      .orderBy(asc(organizationMembers.role), asc(organizationMembers.joinedAt))
  );
}

export async function updateMembershipPreferences(
  userId: number,
  shareFootprint: boolean,
  tx: Executor = db,
) {
  const [row] = await tx
    .update(organizationMembers)
    .set({ shareFootprint })
    .where(eq(organizationMembers.userId, userId))
    .returning({ shareFootprint: organizationMembers.shareFootprint });
  return row ?? null;
}

export async function getOrganizationAnalytics(organizationId: number, tx: Executor = db) {
  // 1. Overall Footprint across all members
  const [emissions] = await tx
    .select({
      totalKg: sql<number>`coalesce(sum(${dailyFootprints.totalKg}), 0)::float`,
      transportKg: sql<number>`coalesce(sum(${dailyFootprints.transportKg}), 0)::float`,
      foodKg: sql<number>`coalesce(sum(${dailyFootprints.foodKg}), 0)::float`,
      homeEnergyKg: sql<number>`coalesce(sum(${dailyFootprints.homeEnergyKg}), 0)::float`,
      waterKg: sql<number>`coalesce(sum(${dailyFootprints.waterKg}), 0)::float`,
      wasteKg: sql<number>`coalesce(sum(${dailyFootprints.wasteKg}), 0)::float`,
      activeLoggers: sql<number>`count(distinct ${dailyFootprints.userId})::int`,
    })
    .from(dailyFootprints)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, dailyFootprints.userId))
    .where(eq(organizationMembers.organizationId, organizationId));

  // 2. Member Count & Baseline Total
  const [memberStats] = await tx
    .select({
      totalMembers: sql<number>`count(distinct ${organizationMembers.userId})::int`,
      baselineTotalKg: sql<number>`coalesce(sum(${lifestyleProfiles.baselineTotalKg}), 0)::float`,
    })
    .from(organizationMembers)
    .leftJoin(lifestyleProfiles, eq(lifestyleProfiles.userId, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, organizationId));

  // 3. Monthly Trend (last 12 months)
  const monthlyRows = await tx
    .select({
      month: sql<string>`to_char(${dailyFootprints.logDate}, 'YYYY-MM')`,
      totalKg: sql<number>`coalesce(sum(${dailyFootprints.totalKg}), 0)::float`,
      activeLoggers: sql<number>`count(distinct ${dailyFootprints.userId})::int`,
      avgPerEmployeeKg: sql<number>`(coalesce(sum(${dailyFootprints.totalKg}), 0) / nullif(count(distinct ${dailyFootprints.userId}), 0))::float`,
    })
    .from(dailyFootprints)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, dailyFootprints.userId))
    .where(eq(organizationMembers.organizationId, organizationId))
    .groupBy(sql`to_char(${dailyFootprints.logDate}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${dailyFootprints.logDate}, 'YYYY-MM') asc`)
    .limit(12);

  return {
    emissions: emissions ?? {
      totalKg: 0,
      transportKg: 0,
      foodKg: 0,
      homeEnergyKg: 0,
      waterKg: 0,
      wasteKg: 0,
      activeLoggers: 0,
    },
    memberStats: memberStats ?? { totalMembers: 0, baselineTotalKg: 0 },
    monthlyTrend: monthlyRows ?? [],
  };
}

export function listOrganizations(opts: {
  status?: string;
  type?: string;
  afterId: number | null;
  limit: number;
}) {
  return db
    .select(ORG_COLUMNS)
    .from(organizations)
    .where(
      and(
        opts.status ? eq(organizations.status, opts.status as OrgRow['status']) : undefined,
        opts.type ? eq(organizations.type, opts.type as OrgRow['type']) : undefined,
        opts.afterId !== null ? lt(organizations.id, opts.afterId) : undefined,
      ),
    )
    .orderBy(desc(organizations.id))
    .limit(opts.limit + 1);
}

export async function insertOrganization(tx: Executor, values: typeof organizations.$inferInsert) {
  const [row] = await tx.insert(organizations).values(values).returning({ id: organizations.id });
  if (!row) throw new Error('organization insert returned nothing');
  return row.id;
}

/**
 * Applies an owner's edit, deciding IN SQL whether it re-opens the review.
 *
 * The decision cannot be made from a prior SELECT. An owner reads `pending`,
 * an admin approves in the same instant, and the rename then lands on a row
 * that is now `approved` — keeping the badge for a name no human ever saw.
 * Making it a CASE over the row's own `status` means the comparison happens
 * at write time, against whatever the row actually is.
 *
 * `IS DISTINCT FROM` rather than `<>` so a NULL on either side compares
 * sanely: setting a website on an organization that had none is a change.
 */
export async function updateOrganizationChecked(
  id: number,
  values: Partial<typeof organizations.$inferInsert>,
  identity: { name?: string | null; logoUrl?: string | null; websiteUrl?: string | null },
) {
  const changed = sql.join(
    [
      identity.name !== undefined ? sql`name is distinct from ${identity.name}` : null,
      identity.logoUrl !== undefined ? sql`logo_url is distinct from ${identity.logoUrl}` : null,
      identity.websiteUrl !== undefined
        ? sql`website_url is distinct from ${identity.websiteUrl}`
        : null,
    ].filter((x): x is NonNullable<typeof x> => x !== null),
    sql` or `,
  );

  // Nothing identity-shaped in this patch, so the approval is undisturbed.
  if (
    identity.name === undefined &&
    identity.logoUrl === undefined &&
    identity.websiteUrl === undefined
  ) {
    return updateOrganization(id, values);
  }

  const reopens = sql`(status = 'approved' and (${changed}))`;
  return updateOrganization(id, {
    ...values,
    status: sql`case when ${reopens} then 'pending'::organization_status else status end` as never,
    reviewedAt: sql`case when ${reopens} then null else reviewed_at end` as never,
    reviewNote: sql`case when ${reopens} then null else review_note end` as never,
  });
}

/**
 * The admin decision, applied ONLY if the organization still looks the way
 * the queue showed it.
 *
 * The comparison belongs in the WHERE, not in a prior SELECT: checking and
 * then writing is the same read-then-write race this module already fixed
 * once, and here the window is wide — an admin reads the queue, thinks,
 * then clicks. All three identity fields are compared, not just the name,
 * because a swapped logo or website impersonates just as well.
 *
 * `IS NOT DISTINCT FROM` so NULL matches NULL.
 */
export async function reviewIfUnchanged(
  id: number,
  values: Partial<typeof organizations.$inferInsert>,
  expected: { name: string; logoUrl: string | null; websiteUrl: string | null },
) {
  const [row] = await db
    .update(organizations)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(
        eq(organizations.id, id),
        eq(organizations.name, expected.name),
        sql`${organizations.logoUrl} is not distinct from ${expected.logoUrl}`,
        sql`${organizations.websiteUrl} is not distinct from ${expected.websiteUrl}`,
      ),
    )
    .returning({ id: organizations.id });
  return row ?? null;
}

export async function updateOrganization(
  id: number,
  values: Partial<typeof organizations.$inferInsert>,
  tx: Executor = db,
) {
  const [row] = await tx
    .update(organizations)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(organizations.id, id))
    .returning({ id: organizations.id });
  return row ?? null;
}

export async function insertMember(tx: Executor, values: typeof organizationMembers.$inferInsert) {
  const [row] = await tx.insert(organizationMembers).values(values).returning();
  if (!row) throw new Error('organization member insert returned nothing');
  return row;
}

export async function removeMember(organizationId: number, userId: number) {
  const [row] = await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .returning({ id: organizationMembers.id });
  return row ?? null;
}

/**
 * Owners left, counted under a row lock.
 *
 * `FOR UPDATE` matters: two owners deleting each other at the same moment
 * would both read a count of 2, both pass the "more than one owner" check
 * and both commit, leaving an organization with no owner at all — nobody
 * can administer it and nobody can leave. The lock serialises them so the
 * second sees 1 and is refused.
 */
export async function lockOwnerCount(tx: Executor, organizationId: number) {
  const rows = await tx.execute(sql`
    select count(*)::int as n from (
      select 1 from ${organizationMembers}
       where organization_id = ${organizationId} and role = 'owner'
       for update
    ) locked
  `);
  return Number(rows.rows[0]?.n ?? 0);
}

export async function removeMemberIn(tx: Executor, organizationId: number, userId: number) {
  const [row] = await tx
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .returning({ id: organizationMembers.id });
  return row ?? null;
}

export async function findUserByEmail(email: string) {
  const [row] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()} and ${users.deletedAt} is null`);
  return row ?? null;
}

export async function slugTaken(slug: string, tx: Executor = db) {
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug));
  return row !== undefined;
}

// --- Part 4: Custom Onboarding Questions & Answers --------------------------

export type QuestionRow = typeof organizationOnboardingQuestions.$inferSelect;
export type AnswerRow = typeof organizationOnboardingAnswers.$inferSelect;

export async function listQuestions(
  organizationId: number,
  tx: Executor = db,
): Promise<QuestionRow[]> {
  return tx
    .select()
    .from(organizationOnboardingQuestions)
    .where(
      and(
        eq(organizationOnboardingQuestions.organizationId, organizationId),
        eq(organizationOnboardingQuestions.active, true),
      ),
    )
    .orderBy(
      asc(organizationOnboardingQuestions.sortOrder),
      asc(organizationOnboardingQuestions.id),
    );
}

export async function findQuestionById(
  id: number,
  tx: Executor = db,
): Promise<QuestionRow | null> {
  const [row] = await tx
    .select()
    .from(organizationOnboardingQuestions)
    .where(eq(organizationOnboardingQuestions.id, id));
  return row ?? null;
}

export async function createQuestion(
  organizationId: number,
  values: {
    prompt: string;
    description?: string | null;
    type: string;
    options?: string[] | null;
    required: boolean;
  },
  tx: Executor = db,
): Promise<QuestionRow> {
  const [maxOrder] = await tx
    .select({
      max: sql<number>`coalesce(max(${organizationOnboardingQuestions.sortOrder}), -1)::int`,
    })
    .from(organizationOnboardingQuestions)
    .where(eq(organizationOnboardingQuestions.organizationId, organizationId));

  const sortOrder = (maxOrder?.max ?? -1) + 1;

  const [row] = await tx
    .insert(organizationOnboardingQuestions)
    .values({
      organizationId,
      prompt: values.prompt.trim(),
      description: values.description ? values.description.trim() : null,
      type: values.type,
      options: values.options ?? null,
      required: values.required,
      sortOrder,
      version: 1,
      active: true,
    })
    .returning();

  if (!row) throw new Error('Failed to insert question');
  return row;
}

export async function updateQuestion(
  id: number,
  values: {
    prompt?: string;
    description?: string | null;
    type?: string;
    options?: string[] | null;
    required?: boolean;
  },
  tx: Executor = db,
): Promise<QuestionRow | null> {
  const existing = await findQuestionById(id, tx);
  if (!existing) return null;

  // If prompt or type is changed, increment version
  const shouldBumpVersion =
    (values.prompt && values.prompt.trim() !== existing.prompt) ||
    (values.type && values.type !== existing.type);

  const [row] = await tx
    .update(organizationOnboardingQuestions)
    .set({
      prompt: values.prompt !== undefined ? values.prompt.trim() : existing.prompt,
      description: values.description !== undefined ? values.description : existing.description,
      type: values.type !== undefined ? values.type : existing.type,
      options: values.options !== undefined ? values.options : existing.options,
      required: values.required !== undefined ? values.required : existing.required,
      version: shouldBumpVersion ? existing.version + 1 : existing.version,
      updatedAt: new Date(),
    })
    .where(eq(organizationOnboardingQuestions.id, id))
    .returning();

  return row ?? null;
}

export async function reorderQuestions(
  organizationId: number,
  questionIds: number[],
  tx: Executor = db,
): Promise<void> {
  for (let i = 0; i < questionIds.length; i++) {
    const qId = questionIds[i]!;
    await tx
      .update(organizationOnboardingQuestions)
      .set({ sortOrder: i, updatedAt: new Date() })
      .where(
        and(
          eq(organizationOnboardingQuestions.id, qId),
          eq(organizationOnboardingQuestions.organizationId, organizationId),
        ),
      );
  }
}

export async function deleteQuestion(id: number, tx: Executor = db): Promise<boolean> {
  const [row] = await tx
    .update(organizationOnboardingQuestions)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(organizationOnboardingQuestions.id, id))
    .returning({ id: organizationOnboardingQuestions.id });
  return Boolean(row);
}

export async function listAnswersForUser(
  organizationId: number,
  userId: number,
  tx: Executor = db,
): Promise<AnswerRow[]> {
  return tx
    .select()
    .from(organizationOnboardingAnswers)
    .where(
      and(
        eq(organizationOnboardingAnswers.organizationId, organizationId),
        eq(organizationOnboardingAnswers.userId, userId),
      ),
    )
    .orderBy(asc(organizationOnboardingAnswers.questionId));
}

export async function upsertAnswers(
  organizationId: number,
  userId: number,
  items: Array<{
    questionId: number;
    questionPrompt: string;
    questionType: string;
    questionVersion: number;
    answer: unknown;
  }>,
  tx: Executor = db,
): Promise<void> {
  for (const item of items) {
    await tx
      .insert(organizationOnboardingAnswers)
      .values({
        organizationId,
        userId,
        questionId: item.questionId,
        questionPrompt: item.questionPrompt,
        questionType: item.questionType,
        questionVersion: item.questionVersion,
        answer: item.answer,
      })
      .onConflictDoUpdate({
        target: [
          organizationOnboardingAnswers.organizationId,
          organizationOnboardingAnswers.userId,
          organizationOnboardingAnswers.questionId,
        ],
        set: {
          questionPrompt: item.questionPrompt,
          questionType: item.questionType,
          questionVersion: item.questionVersion,
          answer: item.answer,
          updatedAt: new Date(),
        },
      });
  }
}
