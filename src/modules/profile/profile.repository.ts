import type { Executor } from '@common/rewards/rewards.ts';
import { db } from '@database/client.ts';
import {
  dailyFootprints,
  dailyLogs,
  eventPasses,
  goals,
  lifestyleProfiles,
  rewardTransactions,
  users,
} from '@database/schema/index.ts';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';

/** Every Drizzle query for the profile and onboarding module. */

export async function findUser(userId: number) {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  return row ?? null;
}

export async function findProfile(userId: number) {
  const [row] = await db
    .select()
    .from(lifestyleProfiles)
    .where(eq(lifestyleProfiles.userId, userId));
  return row ?? null;
}

/**
 * The profile row, created empty on first touch.
 *
 * ON CONFLICT rather than a read-then-insert: two tabs opening the wizard at
 * once would otherwise both see no row and both insert, and `user_id` is
 * unique so the loser would 500 on a duplicate key.
 */
export async function ensureProfile(userId: number) {
  await db.insert(lifestyleProfiles).values({ userId }).onConflictDoNothing({
    target: lifestyleProfiles.userId,
  });
  const row = await findProfile(userId);
  if (!row) throw new Error(`lifestyle_profiles row missing for user ${userId}`);
  return row;
}

export type ProfilePatch = Partial<typeof lifestyleProfiles.$inferInsert>;

export async function updateProfile(userId: number, patch: ProfilePatch, tx: Executor = db) {
  const [row] = await tx
    .update(lifestyleProfiles)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(lifestyleProfiles.userId, userId))
    .returning();
  return row ?? null;
}

export async function updateUser(
  userId: number,
  patch: Partial<typeof users.$inferInsert>,
  tx: Executor = db,
) {
  const [row] = await tx
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return row ?? null;
}

/** Ledger page, newest first, one row past the limit for `hasMore`. */
export function listRewards(userId: number, limit: number, beforeId: number | null) {
  return db
    .select({
      id: rewardTransactions.id,
      pointsDelta: rewardTransactions.pointsDelta,
      coinsDelta: rewardTransactions.coinsDelta,
      source: rewardTransactions.source,
      note: rewardTransactions.note,
      createdAt: rewardTransactions.createdAt,
    })
    .from(rewardTransactions)
    .where(
      and(
        eq(rewardTransactions.userId, userId),
        beforeId === null ? undefined : lt(rewardTransactions.id, beforeId),
      ),
    )
    .orderBy(desc(rewardTransactions.id))
    .limit(limit + 1);
}

/**
 * Public profile: rank, streak and events attended, never a footprint.
 *
 * The rank is a window function over the whole table rather than a stored
 * column, so it cannot go stale. `points_total DESC, created_at ASC` is the
 * same ordering the leaderboard uses — the tiebreak matters, or two users on
 * equal points would swap places between requests.
 */
export async function findPublicProfile(userId: number) {
  const ranked = db
    .select({
      id: users.id,
      rank: sql<number>`rank() over (order by ${users.pointsTotal} desc, ${users.createdAt} asc)::int`.as(
        'rank',
      ),
    })
    .from(users)
    .where(isNull(users.deletedAt))
    .as('ranked');

  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      avatarUrl: users.avatarUrl,
      city: users.city,
      pointsTotal: users.pointsTotal,
      currentStreak: users.currentStreak,
      createdAt: users.createdAt,
      globalRank: ranked.rank,
      eventsAttended: sql<number>`(
        select count(*)::int from ${eventPasses}
        where ${eventPasses.userId} = ${users.id} and ${eventPasses.status} = 'checked_in'
      )`,
    })
    .from(users)
    .innerJoin(ranked, eq(ranked.id, users.id))
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));

  return row ?? null;
}

/** Everything we hold on one user, for the data export (PRD-v2 §6.8). */
export async function exportUser(userId: number) {
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      emailVerifiedAt: users.emailVerifiedAt,
      avatarUrl: users.avatarUrl,
      city: users.city,
      regionCode: users.regionCode,
      timezone: users.timezone,
      pointsTotal: users.pointsTotal,
      coinsBalance: users.coinsBalance,
      currentStreak: users.currentStreak,
      longestStreak: users.longestStreak,
      onboardedAt: users.onboardedAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId));

  const [profile, logs, footprints, rewards, userGoals, passes] = await Promise.all([
    findProfile(userId),
    db.select().from(dailyLogs).where(eq(dailyLogs.userId, userId)).orderBy(dailyLogs.logDate),
    db
      .select()
      .from(dailyFootprints)
      .where(eq(dailyFootprints.userId, userId))
      .orderBy(dailyFootprints.logDate),
    db
      .select()
      .from(rewardTransactions)
      .where(eq(rewardTransactions.userId, userId))
      .orderBy(rewardTransactions.id),
    db.select().from(goals).where(eq(goals.userId, userId)).orderBy(goals.id),
    db.select().from(eventPasses).where(eq(eventPasses.userId, userId)).orderBy(eventPasses.id),
  ]);

  return { user: user ?? null, profile, logs, footprints, rewards, goals: userGoals, passes };
}

/**
 * Soft-delete and anonymise in one statement (PRD-v2 §6.8).
 *
 * The email is overwritten rather than merely tombstoned, because
 * `users_email_lower_unq` is not partial on `deleted_at` — leaving the address
 * in place would block the person from ever signing up again. Sessions are
 * cascaded by the FK.
 */
export async function anonymise(userId: number) {
  const [row] = await db
    .update(users)
    .set({
      name: 'Deleted user',
      email: `deleted+${userId}@ecolife.invalid`,
      phone: null,
      avatarUrl: null,
      city: null,
      passwordHash: '',
      deletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .returning({ id: users.id });
  return row ?? null;
}
