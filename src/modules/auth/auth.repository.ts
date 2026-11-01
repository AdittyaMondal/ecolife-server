import { db } from '@database/client.ts';
import {
  emailTokens,
  lifestyleProfiles,
  notifications,
  organizationMembers,
  organizations,
  users,
} from '@database/schema/index.ts';
import { and, eq, isNull, sql } from 'drizzle-orm';

/** Every Drizzle query the auth module makes. No other module touches these tables. */

/**
 * Looked up on lower(email) so the unique index is used and a case variant
 * cannot become a second account (see users.ts).
 */
export async function findUserByEmail(email: string) {
  const [row] = await db
    .select()
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email.toLowerCase()}`, isNull(users.deletedAt)));
  return row ?? null;
}

export async function findUserById(id: number) {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)));
  return row ?? null;
}

export async function createUser(input: {
  name: string;
  email: string;
  passwordHash: string;
  phone?: string;
  timezone: string;
  emailVerifiedAt?: Date;
  /** Only ever an https URL, validated by the caller. Null to leave unset. */
  avatarUrl?: string | null;
}) {
  const [row] = await db
    .insert(users)
    .values({ ...input, email: input.email.toLowerCase() })
    .returning();
  // An insert with RETURNING that yields no row cannot happen; making the
  // return type optional only pushes a null check onto every caller.
  if (!row) throw new Error('user insert returned nothing');
  return row;
}

/** The caller's organization and role, if any. One row at most (one_org_per_user). */
export async function findMembership(userId: number) {
  const [row] = await db
    .select({
      orgId: organizations.id,
      slug: organizations.slug,
      code: organizations.code,
      name: organizations.name,
      type: organizations.type,
      status: organizations.status,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, userId));
  return row ?? null;
}

export async function markEmailVerified(userId: number) {
  await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId)).execute();
}

/**
 * Voids every unused verify/reset link for a user.
 *
 * Needed when an account changes hands: a pending reset link in an attacker's
 * inbox would otherwise still work after the real owner took the account over.
 */
export async function revokePendingEmailTokens(userId: number) {
  await db
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(emailTokens.userId, userId), isNull(emailTokens.usedAt)))
    .execute();
}

export async function setPassword(userId: number, passwordHash: string) {
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId)).execute();
}

export async function storeEmailToken(input: {
  tokenHash: string;
  userId: number;
  purpose: 'verify' | 'reset';
  expiresAt: Date;
}) {
  await db.insert(emailTokens).values(input).execute();
}

/** Single-use: returns the row only if it exists, is unused and is unexpired. */
export async function consumeEmailToken(tokenHash: string, purpose: 'verify' | 'reset') {
  const [row] = await db
    .select()
    .from(emailTokens)
    .where(and(eq(emailTokens.tokenHash, tokenHash), eq(emailTokens.purpose, purpose)));

  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) return null;

  await db
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(eq(emailTokens.tokenHash, tokenHash))
    .execute();
  return row;
}

/** Onboarding progress and the unread badge, both promised by /auth/me. */
export async function findProfileState(userId: number) {
  const [profile] = await db
    .select({ completedSteps: lifestyleProfiles.completedSteps })
    .from(lifestyleProfiles)
    .where(eq(lifestyleProfiles.userId, userId));

  const [unread] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

  return { completedSteps: profile?.completedSteps ?? 0, unreadNotifications: unread?.n ?? 0 };
}
