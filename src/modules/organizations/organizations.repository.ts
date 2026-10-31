import type { Executor } from '@common/rewards/rewards.ts';
import { db } from '@database/client.ts';
import { organizationMembers, organizations, users } from '@database/schema/index.ts';
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

export function listMembers(organizationId: number) {
  return (
    db
      .select({
        id: users.id,
        name: users.name,
        avatarUrl: users.avatarUrl,
        city: users.city,
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
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

/** Owners left, so the last one cannot remove themselves and orphan the org. */
export async function ownerCount(organizationId: number, tx: Executor = db) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.role, 'owner'),
      ),
    );
  return row?.n ?? 0;
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
