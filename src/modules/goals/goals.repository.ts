import type { Executor } from '@common/rewards/rewards.ts';
import { db } from '@database/client.ts';
import { dailyFootprints, goals } from '@database/schema/index.ts';
import { and, between, desc, eq, ne, sql } from 'drizzle-orm';

/** Every Drizzle query for the goals module. */

export type GoalRow = typeof goals.$inferSelect;

export async function findActive(userId: number, tx: Executor = db) {
  const [row] = await tx
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.status, 'active')));
  return row ?? null;
}

export function listPast(userId: number) {
  return db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), ne(goals.status, 'active')))
    .orderBy(desc(goals.id))
    .limit(50);
}

/** Scoped to the owner in the WHERE, so a foreign id is simply not found. */
export async function findOwned(userId: number, id: number, tx: Executor = db) {
  const [row] = await tx
    .select()
    .from(goals)
    .where(and(eq(goals.id, id), eq(goals.userId, userId)));
  return row ?? null;
}

export async function insertGoal(values: typeof goals.$inferInsert, tx: Executor = db) {
  const [row] = await tx.insert(goals).values(values).returning();
  if (!row) throw new Error('goal insert returned nothing');
  return row;
}

export async function updateGoal(
  id: number,
  values: Partial<typeof goals.$inferInsert>,
  tx: Executor = db,
) {
  const [row] = await tx.update(goals).set(values).where(eq(goals.id, id)).returning();
  return row ?? null;
}

/**
 * Settles a goal, but only if it is still active.
 *
 * The `status = 'active'` predicate is the concurrency control: two requests
 * that both notice an expired goal would otherwise both settle it and both
 * try to award. Here the loser updates no rows and skips its award entirely.
 */
export async function settleIfActive(
  id: number,
  values: { status: 'achieved' | 'missed' | 'cancelled'; actualKgTotal: number | null },
  tx: Executor = db,
) {
  const [row] = await tx
    .update(goals)
    .set({ ...values, settledAt: new Date() })
    .where(and(eq(goals.id, id), eq(goals.status, 'active')))
    .returning();
  return row ?? null;
}

/**
 * Total kg logged in a window, and how many days actually have a row.
 *
 * Both numbers matter: the sum alone cannot distinguish a genuinely low
 * fortnight from one where the user simply stopped logging, and a goal that
 * rewards silence would be trivially farmable.
 */
export async function sumFootprints(userId: number, from: string, to: string) {
  const [row] = await db
    .select({
      totalKg: sql<number>`coalesce(sum(${dailyFootprints.totalKg}), 0)::double precision`,
      days: sql<number>`count(*)::int`,
    })
    .from(dailyFootprints)
    .where(and(eq(dailyFootprints.userId, userId), between(dailyFootprints.logDate, from, to)));
  return { totalKg: row?.totalKg ?? 0, days: row?.days ?? 0 };
}
