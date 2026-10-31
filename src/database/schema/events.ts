import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { eventStatus, eventType, eventVisibility } from './enums.ts';
import { users } from './users.ts';

/**
 * Community events — plant drives, clean-ups (PRD-v2 §6.6, §7.5).
 *
 * `registeredCount` and `checkedInCount` are denormalised counters, not
 * computed on read: the scanner shows a running count on every scan and a
 * COUNT(*) per scan is wasteful.
 *
 * They are maintained by the SERVICE, inside the same transaction as the
 * event_passes write — there is no trigger. Registration must therefore be a
 * conditional update:
 *
 *   UPDATE events SET registered_count = registered_count + 1
 *   WHERE id = $1 AND registered_count < capacity RETURNING *
 *
 * and the pass insert only proceeds if that returned a row. The two CHECKs
 * below are the backstop: if a service ever forgets, the write fails rather
 * than overfilling the event. (v1 had a `total_points` column updated only by
 * a seeder, so it was permanently stale — hence the constraints here.)
 */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    type: eventType('type').notNull(),
    status: eventStatus('status').notNull().default('draft'),
    visibility: eventVisibility('visibility').notNull().default('public'),
    coverUrl: text('cover_url'),
    hostId: bigint('host_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    venueName: text('venue_name').notNull(),
    venueAddress: text('venue_address'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    capacity: integer('capacity').notNull().default(100),
    registeredCount: integer('registered_count').notNull().default(0),
    checkedInCount: integer('checked_in_count').notNull().default(0),
    /** Set when check-ins exceed 3x this host's median — awards still granted, admin notified. */
    flaggedForReview: boolean('flagged_for_review').notNull().default(false),
    hostRewardedAt: timestamp('host_rewarded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('events_end_after_start', sql`${t.endAt} > ${t.startAt}`),
    check('events_capacity_positive', sql`${t.capacity} > 0`),
    check('events_registrations_within_capacity', sql`${t.registeredCount} <= ${t.capacity}`),
    check('events_checkins_within_capacity', sql`${t.checkedInCount} <= ${t.capacity}`),
    check('events_checkins_within_registrations', sql`${t.checkedInCount} <= ${t.registeredCount}`),
    index('events_upcoming_idx').on(t.status, t.startAt),
    index('events_geo_idx').on(t.latitude, t.longitude),
  ],
);

/** Host plus co-hosts. Co-hosts may scan; only the host may edit or cancel. */
export const eventHosts = pgTable(
  'event_hosts',
  {
    eventId: bigint('event_id', { mode: 'number' })
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('co_host'),
  },
  (t) => [index('event_hosts_user_idx').on(t.userId)],
);
