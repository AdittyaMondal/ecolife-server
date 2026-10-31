import { db } from '@database/client.ts';
import { dailyFootprints, eventPasses, events } from '@database/schema/index.ts';
import { and, asc, between, eq, gte, inArray, or, sql } from 'drizzle-orm';

/** Every Drizzle query the Home aggregate needs beyond the other modules'. */

/** Footprint rows in a window, oldest first. */
export function footprintsBetween(userId: number, from: string, to: string) {
  return db
    .select({
      logDate: dailyFootprints.logDate,
      totalKg: dailyFootprints.totalKg,
      transportKg: dailyFootprints.transportKg,
      foodKg: dailyFootprints.foodKg,
      homeEnergyKg: dailyFootprints.homeEnergyKg,
      waterKg: dailyFootprints.waterKg,
      wasteKg: dailyFootprints.wasteKg,
      baselineTotalKg: dailyFootprints.baselineTotalKg,
      sources: dailyFootprints.sources,
      dailyLogId: dailyFootprints.dailyLogId,
    })
    .from(dailyFootprints)
    .where(and(eq(dailyFootprints.userId, userId), between(dailyFootprints.logDate, from, to)))
    .orderBy(asc(dailyFootprints.logDate));
}

/** Per-category averages over a window, computed in SQL rather than in JS. */
export async function averageBreakdown(userId: number, from: string, to: string) {
  const [row] = await db
    .select({
      transportKg: sql<number>`coalesce(avg(${dailyFootprints.transportKg}), 0)::double precision`,
      foodKg: sql<number>`coalesce(avg(${dailyFootprints.foodKg}), 0)::double precision`,
      homeEnergyKg: sql<number>`coalesce(avg(${dailyFootprints.homeEnergyKg}), 0)::double precision`,
      waterKg: sql<number>`coalesce(avg(${dailyFootprints.waterKg}), 0)::double precision`,
      wasteKg: sql<number>`coalesce(avg(${dailyFootprints.wasteKg}), 0)::double precision`,
      totalKg: sql<number>`coalesce(avg(${dailyFootprints.totalKg}), 0)::double precision`,
    })
    .from(dailyFootprints)
    .where(and(eq(dailyFootprints.userId, userId), between(dailyFootprints.logDate, from, to)));
  return row ?? null;
}

/**
 * The caller's next event: one they host, or hold a live pass for.
 *
 * Cancelled events and cancelled passes are excluded — a cancelled drive is
 * not something to put on someone's home screen as the next thing happening.
 */
export async function nextEvent(userId: number) {
  const hosted = db.select({ id: events.id }).from(events).where(eq(events.hostId, userId));

  const registered = db
    .select({ id: eventPasses.eventId })
    .from(eventPasses)
    .where(
      and(
        eq(eventPasses.userId, userId),
        inArray(eventPasses.status, ['registered', 'checked_in']),
      ),
    );

  const [row] = await db
    .select({
      id: events.id,
      slug: events.slug,
      title: events.title,
      startAt: events.startAt,
      venueName: events.venueName,
      hostId: events.hostId,
      passId: eventPasses.id,
    })
    .from(events)
    .leftJoin(eventPasses, and(eq(eventPasses.eventId, events.id), eq(eventPasses.userId, userId)))
    .where(
      and(
        gte(events.startAt, new Date()),
        inArray(events.status, ['published', 'ongoing']),
        or(inArray(events.id, hosted), inArray(events.id, registered)),
      ),
    )
    .orderBy(asc(events.startAt))
    .limit(1);

  return row ?? null;
}
