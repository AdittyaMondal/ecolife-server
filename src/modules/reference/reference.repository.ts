import { db } from '@database/client.ts';
import { cities, notifications, regions } from '@database/schema/index.ts';
import { and, asc, desc, eq, ilike, isNull, lt, sql } from 'drizzle-orm';

/** Every Drizzle query for the reference, notification and city modules. */

/**
 * City autocomplete.
 *
 * `ilike 'q%'` rather than '%q%': a prefix match can use `cities_name_idx`,
 * and for a type-ahead on city names a prefix is what a user means anyway.
 * `%` and `_` in the input are escaped, so a query of "%" does not become a
 * full table scan returning every city.
 */
export function searchCities(q: string, limit: number) {
  const prefix = `${q.replace(/[\\%_]/g, '\\$&')}%`;
  return db
    .select({ id: cities.id, name: cities.name, regionCode: cities.regionCode })
    .from(cities)
    .where(ilike(cities.name, prefix))
    .orderBy(asc(cities.name))
    .limit(limit);
}

export function listRegions() {
  return db
    .select({
      code: regions.code,
      name: regions.name,
      gridKgPerKwh: regions.gridKgPerKwh,
      tariffPaisePerKwh: regions.tariffPaisePerKwh,
    })
    .from(regions)
    .orderBy(asc(regions.name));
}

/** One region, for the baseline's grid factor. */
export async function findRegion(code: string) {
  const [row] = await db.select().from(regions).where(eq(regions.code, code));
  return row ?? null;
}

/** The region a city sits in — onboarding stores a city, the engine needs a grid. */
export async function findRegionByCity(cityId: number) {
  const [row] = await db
    .select({
      code: regions.code,
      name: regions.name,
      gridKgPerKwh: regions.gridKgPerKwh,
      tariffPaisePerKwh: regions.tariffPaisePerKwh,
    })
    .from(cities)
    .innerJoin(regions, eq(regions.code, cities.regionCode))
    .where(eq(cities.id, cityId));
  return row ?? null;
}

/** Newest first, one row past the limit so the caller can compute `hasMore`. */
export function listNotifications(userId: number, limit: number, beforeId: number | null) {
  return db
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      linkPath: notifications.linkPath,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        beforeId === null ? undefined : lt(notifications.id, beforeId),
      ),
    )
    .orderBy(desc(notifications.id))
    .limit(limit + 1);
}

/**
 * Marks one notification read and returns it.
 *
 * The `user_id` predicate is on the UPDATE itself, not a separate ownership
 * check: a read-then-write would let one user mark another's notification
 * read in the window between the two statements, and it costs an extra query
 * to be wrong.
 *
 * `read_at` is only set when it is still null, so re-reading keeps the
 * original timestamp. `returning` still yields the row either way.
 */
export async function markNotificationRead(userId: number, id: number) {
  const [row] = await db
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
    .returning({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      linkPath: notifications.linkPath,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    });
  return row ?? null;
}

export async function countUnread(userId: number) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

/** Used by the track, goal and event flows to tell a user something happened. */
export async function createNotification(input: {
  userId: number;
  type: string;
  title: string;
  body?: string | null;
  linkPath?: string | null;
}) {
  const [row] = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      linkPath: input.linkPath ?? null,
    })
    .returning({ id: notifications.id });
  return row ?? null;
}
