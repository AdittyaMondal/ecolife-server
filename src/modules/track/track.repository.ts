import type { Executor } from '@common/rewards/rewards.ts';
import { db } from '@database/client.ts';
import { dailyFootprints, dailyLogs, users } from '@database/schema/index.ts';
import { and, asc, between, eq, sql } from 'drizzle-orm';

/** Every Drizzle query for the track module. */

export type LogRow = typeof dailyLogs.$inferSelect;
export type FootprintRow = typeof dailyFootprints.$inferSelect;

export async function findLogByDate(userId: number, logDate: string, tx: Executor = db) {
  const [row] = await tx
    .select()
    .from(dailyLogs)
    .where(and(eq(dailyLogs.userId, userId), eq(dailyLogs.logDate, logDate)));
  return row ?? null;
}

export async function findLogById(userId: number, id: number, tx: Executor = db) {
  const [row] = await tx
    .select()
    .from(dailyLogs)
    .where(and(eq(dailyLogs.id, id), eq(dailyLogs.userId, userId)));
  return row ?? null;
}

/**
 * Inserts the log, or returns the existing row for a replayed submit.
 *
 * `daily_log_client_unq` on `(user_id, client_log_id)` is what makes the
 * mobile offline queue safe: a queue that drains twice hits the conflict and
 * gets the first row back rather than a second footprint and a second reward.
 * `daily_log_user_date_unq` separately stops two different client ids
 * claiming the same date.
 */
export async function insertLog(
  tx: Executor,
  values: typeof dailyLogs.$inferInsert,
): Promise<{ row: LogRow; created: boolean }> {
  const inserted = await tx
    .insert(dailyLogs)
    .values(values)
    .onConflictDoNothing({ target: [dailyLogs.userId, dailyLogs.clientLogId] })
    .returning();

  const created = inserted[0];
  if (created) return { row: created, created: true };

  const [existing] = await tx
    .select()
    .from(dailyLogs)
    .where(and(eq(dailyLogs.userId, values.userId), eq(dailyLogs.clientLogId, values.clientLogId)));
  if (!existing) throw new Error('daily log vanished between insert and read');
  return { row: existing, created: false };
}

export async function updateLog(
  tx: Executor,
  id: number,
  values: Partial<typeof dailyLogs.$inferInsert>,
) {
  const [row] = await tx
    .update(dailyLogs)
    .set({ ...values, editedAt: new Date() })
    .where(eq(dailyLogs.id, id))
    .returning();
  return row ?? null;
}

/** Idempotent per (user, date) — the unique index makes the upsert safe. */
export async function upsertFootprint(tx: Executor, values: typeof dailyFootprints.$inferInsert) {
  const [row] = await tx
    .insert(dailyFootprints)
    .values(values)
    .onConflictDoUpdate({
      target: [dailyFootprints.userId, dailyFootprints.logDate],
      set: {
        dailyLogId: values.dailyLogId,
        transportKg: values.transportKg,
        foodKg: values.foodKg,
        homeEnergyKg: values.homeEnergyKg,
        waterKg: values.waterKg,
        wasteKg: values.wasteKg,
        totalKg: values.totalKg,
        baselineTotalKg: values.baselineTotalKg,
        reductionPct: values.reductionPct,
        sources: values.sources,
        clamped: values.clamped,
        factorVersion: values.factorVersion,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error('footprint upsert returned nothing');
  return row;
}

export function listFootprints(userId: number, from: string, to: string) {
  return db
    .select({
      logDate: dailyFootprints.logDate,
      totalKg: dailyFootprints.totalKg,
      baselineTotalKg: dailyFootprints.baselineTotalKg,
      dailyLogId: dailyFootprints.dailyLogId,
    })
    .from(dailyFootprints)
    .where(and(eq(dailyFootprints.userId, userId), between(dailyFootprints.logDate, from, to)))
    .orderBy(asc(dailyFootprints.logDate));
}

/**
 * The dates with a log in a window, newest first — the streak input.
 *
 * Reads `daily_logs`, not `daily_footprints`: a streak is a record of showing
 * up, and a footprint row can also be written by a backfill.
 */
export async function loggedDatesSince(userId: number, since: string, tx: Executor = db) {
  const rows = await tx
    .select({ logDate: dailyLogs.logDate })
    .from(dailyLogs)
    .where(and(eq(dailyLogs.userId, userId), sql`${dailyLogs.logDate} >= ${since}`))
    .orderBy(asc(dailyLogs.logDate));
  return rows.map((r) => r.logDate);
}

export async function setStreak(tx: Executor, userId: number, current: number, longest: number) {
  await tx
    .update(users)
    .set({ currentStreak: current, longestStreak: longest, updatedAt: new Date() })
    .where(eq(users.id, userId));
}
