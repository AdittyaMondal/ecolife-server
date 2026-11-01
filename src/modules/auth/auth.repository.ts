import type { Executor } from '@common/rewards/rewards.ts';
import { db } from '@database/client.ts';
import {
  addresses,
  cartItems,
  emailTokens,
  lifestyleProfiles,
  notifications,
  organizationMembers,
  organizations,
  pushTokens,
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

export async function markEmailVerified(userId: number, tx: Executor = db) {
  await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId)).execute();
}

/**
 * Voids every unused verify/reset link for a user.
 *
 * Needed when an account changes hands: a pending reset link in an attacker's
 * inbox would otherwise still work after the real owner took the account over.
 */
export async function revokePendingEmailTokens(userId: number, tx: Executor = db) {
  await tx
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(emailTokens.userId, userId), isNull(emailTokens.usedAt)))
    .execute();
}

/**
 * Drops state a stranger could have attached to an unverified account.
 *
 * Used only by the Google-sign-in takeover. An unverified row never proved who
 * owns the address, so anything RELATIONAL on it is of unknown provenance —
 * and two kinds of it have real consequences for the person inheriting the
 * row:
 *
 *   organization_members  the squatter's organization would silently gain a
 *                         member and, through shareFootprint, visibility of
 *                         the real owner's footprint data
 *   addresses             a saved default address means the next order ships
 *                         to the squatter
 *   cart_items            a pre-loaded cart the owner did not choose
 *   push_tokens           notifications meant for the owner, delivered to the
 *                         squatter's device
 *
 * The cut line, for whoever adds the next user-owned table: drop it here if a
 * stranger setting it would expose the owner's data or redirect something
 * physical. Carbon history (daily_logs, daily_footprints, goals) and the
 * lifestyle profile are deliberately KEPT — they are the account's own data,
 * harmless to inherit, and discarding them would wipe the common case of
 * someone who simply registered and never clicked the verify link.
 *
 * Reaches across module boundaries (§4.4) for the same reason
 * `profile.repository.anonymise` does: deleting or re-owning an account is one
 * operation over every table that hangs off it, not several.
 */
export async function scrubUnprovenState(userId: number, tx: Executor = db) {
  await tx.delete(organizationMembers).where(eq(organizationMembers.userId, userId)).execute();
  await tx.delete(addresses).where(eq(addresses.userId, userId)).execute();
  await tx.delete(cartItems).where(eq(cartItems.userId, userId)).execute();
  await tx.delete(pushTokens).where(eq(pushTokens.userId, userId)).execute();
}

export async function setPassword(userId: number, passwordHash: string, tx: Executor = db) {
  await tx.update(users).set({ passwordHash }).where(eq(users.id, userId)).execute();
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
