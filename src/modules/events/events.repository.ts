import type { Executor } from '@common/rewards/rewards.ts';
import { db } from '@database/client.ts';
import {
  eventHosts,
  eventPasses,
  events,
  organizationMembers,
  organizations,
  users,
} from '@database/schema/index.ts';
import { and, asc, desc, eq, gte, inArray, lt, lte, ne, type SQL, sql } from 'drizzle-orm';

/** Every Drizzle query for the events module. */

export type EventRow = typeof events.$inferSelect;
export type PassRow = typeof eventPasses.$inferSelect;

const HOST = {
  hostUserId: users.id,
  hostName: users.name,
  hostAvatarUrl: users.avatarUrl,
  hostCity: users.city,
} as const;

const EVENT_COLUMNS = {
  id: events.id,
  slug: events.slug,
  title: events.title,
  description: events.description,
  type: events.type,
  status: events.status,
  visibility: events.visibility,
  organizationId: events.organizationId,
  coverUrl: events.coverUrl,
  hostId: events.hostId,
  startAt: events.startAt,
  endAt: events.endAt,
  venueName: events.venueName,
  venueAddress: events.venueAddress,
  venueMapUrl: events.venueMapUrl,
  latitude: events.latitude,
  longitude: events.longitude,
  capacity: events.capacity,
  registeredCount: events.registeredCount,
  checkedInCount: events.checkedInCount,
} as const;

/**
 * Great-circle distance in km, in SQL.
 *
 * Computed in the database so the radius can filter and order before rows
 * come back — fetching every event to measure them in JS would read the
 * whole table to show twenty rows.
 */
function haversineKm(lat: number, lng: number): SQL<number> {
  return sql<number>`(
    6371 * acos(
      least(1, greatest(-1,
        cos(radians(${lat})) * cos(radians(${events.latitude}))
          * cos(radians(${events.longitude}) - radians(${lng}))
        + sin(radians(${lat})) * sin(radians(${events.latitude}))
      ))
    )
  )`;
}

export type ListFilter = 'upcoming' | 'nearby' | 'registered' | 'hosting' | 'past';

export async function listEvents(opts: {
  viewerId: number;
  filter: ListFilter;
  type?: string;
  search?: string;
  organizationId?: number;
  lat?: number;
  lng?: number;
  radiusKm: number;
  afterId: number | null;
  limit: number;
}) {
  const now = new Date();
  const near = opts.lat !== undefined && opts.lng !== undefined;
  const distance = near ? haversineKm(opts.lat as number, opts.lng as number) : sql<number>`null`;

  const registeredIds = db
    .select({ id: eventPasses.eventId })
    .from(eventPasses)
    .where(
      and(
        eq(eventPasses.userId, opts.viewerId),
        inArray(eventPasses.status, ['registered', 'checked_in']),
      ),
    );

  const hostingIds = db
    .select({ id: eventHosts.eventId })
    .from(eventHosts)
    .where(eq(eventHosts.userId, opts.viewerId));

  const userOrgIds = db
    .select({ id: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, opts.viewerId));

  const filters: Record<ListFilter, SQL | undefined> = {
    upcoming: and(gte(events.endAt, now), inArray(events.status, ['published', 'ongoing'])),
    nearby: and(
      gte(events.endAt, now),
      inArray(events.status, ['published', 'ongoing']),
      near ? sql`${distance} <= ${opts.radiusKm}` : undefined,
    ),
    registered: and(inArray(events.id, registeredIds), ne(events.status, 'draft')),
    hosting: sql`(${events.hostId} = ${opts.viewerId} or ${events.id} in ${hostingIds})`,
    past: and(lt(events.endAt, now), ne(events.status, 'draft')),
  };

  const rows = await db
    .select({
      ...EVENT_COLUMNS,
      ...HOST,
      organizationName: organizations.name,
      distanceKm: distance,
      passStatus: eventPasses.status,
      coHostRole: eventHosts.role,
    })
    .from(events)
    .innerJoin(users, eq(users.id, events.hostId))
    .leftJoin(organizations, eq(organizations.id, events.organizationId))
    .leftJoin(
      eventPasses,
      and(eq(eventPasses.eventId, events.id), eq(eventPasses.userId, opts.viewerId)),
    )
    .leftJoin(
      eventHosts,
      and(eq(eventHosts.eventId, events.id), eq(eventHosts.userId, opts.viewerId)),
    )
    .where(
      and(
        filters[opts.filter],
        opts.type ? eq(events.type, opts.type as EventRow['type']) : undefined,
        opts.organizationId ? eq(events.organizationId, opts.organizationId) : undefined,
        opts.search
          ? sql`(
              lower(${events.title}) like ${`%${opts.search.trim().toLowerCase()}%`}
              or lower(${events.description}) like ${`%${opts.search.trim().toLowerCase()}%`}
              or lower(coalesce(${events.venueName}, '')) like ${`%${opts.search.trim().toLowerCase()}%`}
              or lower(coalesce(${organizations.name}, '')) like ${`%${opts.search.trim().toLowerCase()}%`}
            )`
          : undefined,
        // Drafts are visible only to the people running them.
        sql`(${events.status} <> 'draft' or ${events.hostId} = ${opts.viewerId})`,
        /**
         * An invite_only event is UNLISTED: it never appears in discovery
         * for anyone who is not running it or already holding a pass.
         */
        sql`(
          ${events.visibility} <> 'invite_only'
          or ${events.hostId} = ${opts.viewerId}
          or ${events.id} in ${hostingIds}
          or ${events.id} in ${registeredIds}
        )`,
        /**
         * An organization_only event is visible ONLY to members of that organization
         * or people running / registered for it.
         */
        sql`(
          ${events.visibility} <> 'organization_only'
          or ${events.hostId} = ${opts.viewerId}
          or ${events.id} in ${hostingIds}
          or ${events.id} in ${registeredIds}
          or (${events.organizationId} is not null and ${events.organizationId} in ${userOrgIds})
        )`,
        opts.afterId !== null ? lt(events.id, opts.afterId) : undefined,
      ),
    )
    .orderBy(opts.filter === 'past' ? desc(events.startAt) : asc(events.startAt), desc(events.id))
    .limit(opts.limit + 1);

  return rows;
}

export async function findBySlug(slug: string, viewerId: number) {
  const [row] = await db
    .select({
      ...EVENT_COLUMNS,
      ...HOST,
      organizationName: organizations.name,
      distanceKm: sql<number | null>`null`,
      passStatus: eventPasses.status,
      coHostRole: eventHosts.role,
    })
    .from(events)
    .innerJoin(users, eq(users.id, events.hostId))
    .leftJoin(organizations, eq(organizations.id, events.organizationId))
    .leftJoin(
      eventPasses,
      and(eq(eventPasses.eventId, events.id), eq(eventPasses.userId, viewerId)),
    )
    .leftJoin(eventHosts, and(eq(eventHosts.eventId, events.id), eq(eventHosts.userId, viewerId)))
    .where(eq(events.slug, slug));
  return row ?? null;
}

export async function findById(id: number, viewerId: number, tx: Executor = db) {
  const [row] = await tx
    .select({
      ...EVENT_COLUMNS,
      ...HOST,
      organizationName: organizations.name,
      distanceKm: sql<number | null>`null`,
      passStatus: eventPasses.status,
      coHostRole: eventHosts.role,
    })
    .from(events)
    .innerJoin(users, eq(users.id, events.hostId))
    .leftJoin(organizations, eq(organizations.id, events.organizationId))
    .leftJoin(
      eventPasses,
      and(eq(eventPasses.eventId, events.id), eq(eventPasses.userId, viewerId)),
    )
    .leftJoin(eventHosts, and(eq(eventHosts.eventId, events.id), eq(eventHosts.userId, viewerId)))
    .where(eq(events.id, id));
  return row ?? null;
}

export async function rawEvent(id: number, tx: Executor = db) {
  const [row] = await tx.select().from(events).where(eq(events.id, id));
  return row ?? null;
}

export async function insertEvent(values: typeof events.$inferInsert) {
  const [row] = await db.insert(events).values(values).returning();
  if (!row) throw new Error('event insert returned nothing');
  return row;
}

export async function updateEvent(id: number, values: Partial<typeof events.$inferInsert>) {
  const [row] = await db.update(events).set(values).where(eq(events.id, id)).returning();
  return row ?? null;
}

/** True when the slug is free. Slugs are unique across all events. */
export async function slugTaken(slug: string) {
  const [row] = await db.select({ id: events.id }).from(events).where(eq(events.slug, slug));
  return row !== undefined;
}

// --- hosts -----------------------------------------------------------------

export async function isHostOrCoHost(eventId: number, userId: number, tx: Executor = db) {
  const event = await rawEvent(eventId, tx);
  if (!event) return { event: null, isHost: false, isCoHost: false };
  if (event.hostId === userId) return { event, isHost: true, isCoHost: false };

  const [row] = await tx
    .select({ role: eventHosts.role })
    .from(eventHosts)
    .where(and(eq(eventHosts.eventId, eventId), eq(eventHosts.userId, userId)));
  return { event, isHost: false, isCoHost: row !== undefined };
}

export async function addCoHost(eventId: number, userId: number) {
  await db.insert(eventHosts).values({ eventId, userId, role: 'co_host' }).onConflictDoNothing();
}

export async function removeCoHost(eventId: number, userId: number) {
  await db
    .delete(eventHosts)
    .where(and(eq(eventHosts.eventId, eventId), eq(eventHosts.userId, userId)));
}

// --- passes ----------------------------------------------------------------

export async function findPass(eventId: number, userId: number, tx: Executor = db) {
  const [row] = await tx
    .select()
    .from(eventPasses)
    .where(and(eq(eventPasses.eventId, eventId), eq(eventPasses.userId, userId)));
  return row ?? null;
}

export async function findPassByHash(eventId: number, hash: string, tx: Executor = db) {
  const [row] = await tx
    .select()
    .from(eventPasses)
    .where(and(eq(eventPasses.eventId, eventId), eq(eventPasses.passCodeHash, hash)));
  return row ?? null;
}

export async function findPassById(eventId: number, passId: number, tx: Executor = db) {
  const [row] = await tx
    .select()
    .from(eventPasses)
    .where(and(eq(eventPasses.eventId, eventId), eq(eventPasses.id, passId)));
  return row ?? null;
}

/**
 * Claims a seat, or returns null when the event is full.
 *
 * `registered_count < capacity` lives in the UPDATE, so two simultaneous
 * registrations for the last seat cannot both succeed — exactly as the
 * events table's own comment requires. The pass is only inserted if this
 * returned a row.
 */
export async function claimSeat(tx: Executor, eventId: number) {
  const [row] = await tx
    .update(events)
    .set({ registeredCount: sql`${events.registeredCount} + 1` })
    .where(and(eq(events.id, eventId), sql`${events.registeredCount} < ${events.capacity}`))
    .returning();
  return row ?? null;
}

export async function releaseSeat(tx: Executor, eventId: number) {
  await tx
    .update(events)
    .set({ registeredCount: sql`greatest(0, ${events.registeredCount} - 1)` })
    .where(eq(events.id, eventId));
}

export async function insertPass(tx: Executor, values: typeof eventPasses.$inferInsert) {
  const [row] = await tx.insert(eventPasses).values(values).returning();
  if (!row) throw new Error('pass insert returned nothing');
  return row;
}

export async function updatePass(
  tx: Executor,
  id: number,
  values: Partial<typeof eventPasses.$inferInsert>,
) {
  const [row] = await tx.update(eventPasses).set(values).where(eq(eventPasses.id, id)).returning();
  return row ?? null;
}

/**
 * Marks a pass checked in, only if it is not already.
 *
 * The `status <> 'checked_in'` predicate is what makes a double scan — two
 * hosts scanning the same person at once — grant exactly one reward.
 */
export async function checkInPass(
  tx: Executor,
  passId: number,
  byUserId: number,
  scanClientId: string | null,
) {
  const [row] = await tx
    .update(eventPasses)
    .set({ status: 'checked_in', checkedInAt: new Date(), checkedInBy: byUserId, scanClientId })
    .where(and(eq(eventPasses.id, passId), ne(eventPasses.status, 'checked_in')))
    .returning();
  return row ?? null;
}

export async function bumpCheckedIn(tx: Executor, eventId: number) {
  const [row] = await tx
    .update(events)
    .set({ checkedInCount: sql`${events.checkedInCount} + 1` })
    .where(and(eq(events.id, eventId), sql`${events.checkedInCount} < ${events.registeredCount}`))
    .returning();
  return row ?? null;
}

export function listParticipants(eventId: number) {
  return db
    .select({
      passId: eventPasses.id,
      status: eventPasses.status,
      registeredAt: eventPasses.registeredAt,
      checkedInAt: eventPasses.checkedInAt,
      userId: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      city: users.city,
    })
    .from(eventPasses)
    .innerJoin(users, eq(users.id, eventPasses.userId))
    .where(eq(eventPasses.eventId, eventId))
    .orderBy(asc(eventPasses.id));
}

/**
 * Distinct checked-in attendees who do NOT run the event.
 *
 * The host reward is for drawing a crowd, so the people running the event
 * cannot be the crowd — a host plus four co-hosts would otherwise reach the
 * five-attendee threshold with nobody else present.
 */
export async function checkedInAttendeeCount(tx: Executor, eventId: number) {
  const [row] = await tx
    .select({ n: sql<number>`count(distinct ${eventPasses.userId})::int` })
    .from(eventPasses)
    .innerJoin(events, eq(events.id, eventPasses.eventId))
    .where(
      and(
        eq(eventPasses.eventId, eventId),
        eq(eventPasses.status, 'checked_in'),
        sql`${eventPasses.userId} <> ${events.hostId}`,
        sql`not exists (
          select 1 from ${eventHosts} h
           where h.event_id = ${eventId} and h.user_id = ${eventPasses.userId}
        )`,
      ),
    );
  return row?.n ?? 0;
}

export async function markHostRewarded(tx: Executor, eventId: number) {
  const [row] = await tx
    .update(events)
    .set({ hostRewardedAt: new Date() })
    .where(and(eq(events.id, eventId), sql`${events.hostRewardedAt} is null`))
    .returning({ id: events.id });
  return row ?? null;
}

export async function userById(id: number) {
  const [row] = await db
    .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl, city: users.city })
    .from(users)
    .where(and(eq(users.id, id), lte(users.id, sql`${users.id}`)));
  return row ?? null;
}
