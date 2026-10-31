import type { Executor } from '@common/rewards/rewards.ts';
import { db } from '@database/client.ts';
import {
  lifestyleProfiles,
  organizationMembers,
  organizations,
  users,
} from '@database/schema/index.ts';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';

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

export async function findByCode(code: string, tx: Executor = db) {
  const trimmed = code.trim();
  const asId = Number.parseInt(trimmed, 10);
  if (Number.isInteger(asId) && String(asId) === trimmed) {
    const byId = await findById(asId, tx);
    if (byId) return byId;
  }
  const [row] = await tx
    .select(ORG_COLUMNS)
    .from(organizations)
    .where(sql`lower(${organizations.slug}) = ${trimmed.toLowerCase()}`);
  return row ?? null;
}

export function listMembers(organizationId: number) {
  return (
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
        city: users.city,
        pointsTotal: users.pointsTotal,
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
        baselineTotalKg: lifestyleProfiles.baselineTotalKg,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(lifestyleProfiles, eq(lifestyleProfiles.userId, users.id))
      .where(eq(organizationMembers.organizationId, organizationId))
      // Owners first, then oldest member first — the list reads as a hierarchy.
      .orderBy(asc(organizationMembers.role), asc(organizationMembers.joinedAt))
  );
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
