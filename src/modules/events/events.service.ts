import { hashToken, mintRefreshToken } from '@common/auth/tokens.ts';
import { DomainError } from '@common/errors/domain-error.ts';
import { decodeIdCursor, type Page, toPage } from '@common/pagination.ts';
import {
  award,
  EVENT_HOST_MIN_ATTENDEES,
  type Executor,
  REWARDS,
} from '@common/rewards/rewards.ts';
import { env } from '@config/env.ts';
import { db } from '@database/client.ts';
import { sendPredefinedNotification } from '@modules/notifications/fcm.service.ts';
import * as orgRepo from '@modules/organizations/organizations.repository.ts';
import * as profileRepo from '@modules/profile/profile.repository.ts';
import * as repo from './events.repository.ts';

/**
 * Community events, QR passes and host check-in (PRD-v2 §6.6).
 *
 * The pass code is 32 random bytes, stored only as a SHA-256 hash and shown
 * to its owner exactly once. A database leak therefore cannot be turned into
 * a wallet of valid passes. A random opaque code beats a signed token here
 * because the scan has to reach the server to credit the reward anyway —
 * there is nothing to verify offline.
 */

/** The scan window: an hour before the start, two hours after the end. */
const SCAN_OPENS_MS = 60 * 60 * 1000;
const SCAN_CLOSES_MS = 2 * 60 * 60 * 1000;

/** Registration closes an hour after the event starts. */
const REGISTRATION_CLOSES_MS = 60 * 60 * 1000;

type ViewRow = NonNullable<Awaited<ReturnType<typeof repo.findById>>>;

function serialiseEvent(row: ViewRow, viewerId: number) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    type: row.type,
    status: row.status,
    visibility: row.visibility,
    organizationId: row.organizationId ?? null,
    organizationName: row.organizationName ?? null,
    coverUrl: row.coverUrl,
    host: {
      id: row.hostUserId,
      name: row.hostName,
      avatarUrl: row.hostAvatarUrl,
      city: row.hostCity,
    },
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    venueName: row.venueName,
    venueAddress: row.venueAddress,
    venueMapUrl: row.venueMapUrl ?? null,
    latitude: row.latitude,
    longitude: row.longitude,
    capacity: row.capacity,
    registeredCount: row.registeredCount,
    checkedInCount: row.checkedInCount,
    distanceKm: row.distanceKm === null ? null : Math.round(Number(row.distanceKm) * 100) / 100,
    viewer: {
      isHost: row.hostId === viewerId,
      isCoHost: row.coHostRole !== null && row.hostId !== viewerId,
      registered: row.passStatus === 'registered' || row.passStatus === 'checked_in',
      passStatus: row.passStatus,
    },
  };
}

export type ListQuery = {
  filter: repo.ListFilter;
  type?: string;
  search?: string;
  organizationId?: number;
  lat?: number;
  lng?: number;
  radiusKm: number;
  cursor?: string;
  limit: number;
};

export type EventView = ReturnType<typeof serialiseEvent>;

export async function list(viewerId: number, query: ListQuery): Promise<Page<EventView>> {
  if (query.filter === 'nearby' && (query.lat === undefined || query.lng === undefined)) {
    throw new DomainError('GEN_400', 'The nearby filter needs lat and lng.', 400);
  }

  const rows = await repo.listEvents({
    viewerId,
    filter: query.filter,
    type: query.type,
    search: query.search,
    organizationId: query.organizationId,
    lat: query.lat,
    lng: query.lng,
    radiusKm: query.radiusKm,
    afterId: decodeIdCursor(query.cursor),
    limit: query.limit,
  });

  const page = toPage(rows, query.limit, (r) => r.id);
  return { items: page.items.map((r) => serialiseEvent(r, viewerId)), pageInfo: page.pageInfo };
}

/** `Beach Clean-up!` -> `beach-clean-up`, with a suffix if that is taken. */
async function uniqueSlug(title: string) {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'event';

  if (!(await repo.slugTaken(base))) return base;
  // A counter would race between two simultaneous creates; random does not,
  // and `events.slug` is unique so a collision fails loudly rather than
  // silently overwriting someone else's event.
  for (let i = 0; i < 5; i++) {
    const candidate = `${base}-${crypto.randomUUID().slice(0, 6)}`;
    if (!(await repo.slugTaken(candidate))) return candidate;
  }
  throw new DomainError('GEN_500', 'Could not allocate a URL for this event.', 500);
}

export type CreateEventBody = {
  title: string;
  description: string;
  type: string;
  visibility: 'public' | 'invite_only' | 'organization_only';
  organizationId?: number | null;
  coverUrl?: string | null;
  startAt: string;
  endAt: string;
  venueName: string;
  venueAddress?: string;
  venueMapUrl?: string | null;
  latitude?: number;
  longitude?: number;
  capacity: number;
  publish: boolean;
};

export async function create(userId: number, body: CreateEventBody) {
  const startAt = new Date(body.startAt);
  const endAt = new Date(body.endAt);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    throw new DomainError('GEN_400', 'startAt and endAt must be valid timestamps.', 400);
  }
  // Checked here so the caller gets a usable message rather than a constraint
  // violation from `events_end_after_start`.
  if (endAt <= startAt) {
    throw new DomainError('EVENT_008', 'An event has to end after it starts.', 422);
  }

  let effectiveOrgId: number | null = body.organizationId ?? null;
  if (!effectiveOrgId) {
    const membership = await orgRepo.findMembership(userId);
    if (membership) {
      effectiveOrgId = membership.id;
    }
  }

  if (body.visibility === 'organization_only') {
    if (!effectiveOrgId) {
      throw new DomainError(
        'EVENT_010',
        'Organization-only events require an associated organization.',
        400,
      );
    }
    const role = await orgRepo.findMemberRole(effectiveOrgId, userId);
    if (!role) {
      throw new DomainError('EVENT_011', 'You do not belong to that organization.', 403);
    }
  }

  const row = await repo.insertEvent({
    slug: await uniqueSlug(body.title),
    title: body.title,
    description: body.description,
    type: body.type as 'cleanup_drive',
    status: body.publish ? 'published' : 'draft',
    visibility: body.visibility,
    organizationId: effectiveOrgId,
    coverUrl: body.coverUrl ?? null,
    hostId: userId,
    startAt,
    endAt,
    venueName: body.venueName,
    venueAddress: body.venueAddress ?? null,
    venueMapUrl: body.venueMapUrl ?? null,
    latitude: body.latitude ?? null,
    longitude: body.longitude ?? null,
    capacity: body.capacity,
  });

  const view = await repo.findById(row.id, userId);
  if (!view) throw new DomainError('EVENT_009', 'Event not found.', 404);
  return serialiseEvent(view, userId);
}

/**
 * Accepts a slug OR a numeric id.
 *
 * Every mutation on an event is keyed by id (`/events/{id}/register`,
 * `/{id}/pass`, `/{id}/check-in`), so a client that holds an event — from a
 * notification payload, a deep link, a pass — holds its id, and reading it
 * back by that id 404'd. Making the one read endpoint take both costs a
 * branch and saves every caller from carrying a second key around.
 *
 * `/^\d+$/` and not `Number()`: slugs are generated from titles, so a title
 * of "2026" produces the slug "2026", and a loose coercion would send it
 * down the id path and 404 a real event.
 */
export async function bySlug(slugOrId: string, viewerId: number) {
  const row = /^\d+$/.test(slugOrId)
    ? await repo.findById(Number(slugOrId), viewerId)
    : await repo.findBySlug(slugOrId, viewerId);
  if (!row) throw new DomainError('EVENT_009', 'Event not found.', 404);
  // A draft is invisible to everyone but the people running it. Same 404 as
  // a nonexistent event, so its existence is not confirmed.
  const canSee = row.status !== 'draft' || row.hostId === viewerId || row.coHostRole !== null;
  if (!canSee) throw new DomainError('EVENT_009', 'Event not found.', 404);

  // Organization-only events are visible only to members or hosts/co-hosts.
  if (row.visibility === 'organization_only' && row.organizationId) {
    const isHost = row.hostId === viewerId || row.coHostRole !== null;
    if (!isHost) {
      const role = await orgRepo.findMemberRole(row.organizationId, viewerId);
      if (!role) {
        throw new DomainError(
          'EVENT_012',
          'This event is exclusive to members of the hosting organization.',
          403,
        );
      }
    }
  }

  return serialiseEvent(row, viewerId);
}

async function assertHost(eventId: number, userId: number, allowCoHost: boolean) {
  const { event, isHost, isCoHost } = await repo.isHostOrCoHost(eventId, userId);
  if (!event) throw new DomainError('EVENT_009', 'Event not found.', 404);
  if (!isHost && !(allowCoHost && isCoHost)) {
    throw new DomainError('EVENT_001', 'Only the host can do that.', 403);
  }
  return event;
}

export async function update(userId: number, id: number, body: Partial<CreateEventBody>) {
  await assertHost(id, userId, false);
  const patch: Record<string, unknown> = {};
  for (const key of [
    'title',
    'description',
    'type',
    'visibility',
    'organizationId',
    'coverUrl',
    'venueName',
    'venueAddress',
    'venueMapUrl',
    'latitude',
    'longitude',
    'capacity',
  ] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (body.startAt !== undefined) patch.startAt = new Date(body.startAt);
  if (body.endAt !== undefined) patch.endAt = new Date(body.endAt);
  if (body.publish === true) patch.status = 'published';

  await repo.updateEvent(id, patch);
  const view = await repo.findById(id, userId);
  if (!view) throw new DomainError('EVENT_009', 'Event not found.', 404);
  return serialiseEvent(view, userId);
}

export async function cancel(userId: number, id: number) {
  await assertHost(id, userId, false);
  await repo.updateEvent(id, { status: 'cancelled' });
  const view = await repo.findById(id, userId);
  if (!view) throw new DomainError('EVENT_009', 'Event not found.', 404);
  return serialiseEvent(view, userId);
}

function passView(pass: repo.PassRow, event: repo.EventRow, passCode: string | null) {
  return {
    id: pass.id,
    eventId: event.id,
    eventTitle: event.title,
    eventStartAt: event.startAt.toISOString(),
    venueName: event.venueName,
    status: pass.status,
    // Empty unless THIS response minted or rotated the code. We store only a
    // hash, so a past code cannot be produced again — POST /events/{id}/register
    // rotates and returns a fresh one for the owner. GET /pass never can.
    passCode: passCode ?? '',
    qrPayload: passCode ? `${env.MOBILE_SCHEME}://pass/${passCode}` : '',
    checkedInAt: pass.checkedInAt?.toISOString() ?? null,
  };
}

/**
 * Registration.
 *
 * KNOWN GAP, stated rather than hidden: `visibility: 'invite_only'` keeps an
 * event out of discovery, but it does not restrict who may join one whose
 * slug or id they have learned. There is no invitations table in the schema,
 * so there is no fact about "was this person invited" to check against —
 * enforcing it would mean inventing a membership rule out of nothing, and a
 * guess that looks like a control is worse than a documented absence.
 *
 * Closing it properly needs an `event_invitations` table (or a signed invite
 * token), and then a predicate here, in `bySlug`, and in the listing.
 */
export async function register(userId: number, eventId: number) {
  const event = await repo.rawEvent(eventId);
  if (!event) throw new DomainError('EVENT_009', 'Event not found.', 404);

  // Organization-only events are exclusive to members of that organization.
  if (event.visibility === 'organization_only' && event.organizationId) {
    const isHost = event.hostId === userId;
    if (!isHost) {
      const role = await orgRepo.findMemberRole(event.organizationId, userId);
      if (!role) {
        throw new DomainError(
          'EVENT_012',
          'This event is exclusive to members of the hosting organization.',
          403,
        );
      }
    }
  }

  const existing = await repo.findPass(eventId, userId);
  if (existing && existing.status !== 'cancelled') {
    /**
     * Idempotent in the sense that matters — no second seat, no second
     * reward — but a pass that is still usable gets a FRESH code instead of
     * the empty string it used to return.
     *
     * We store only a SHA-256 hash, so the original plaintext genuinely
     * cannot be produced again; a reinstall or a second device was therefore
     * left holding a pass with no QR and no way to get one. Minting a new
     * code for the authenticated owner is the only recovery that does not
     * mean keeping check-in credentials readable at rest. The old code stops
     * working, which is correct for a rotated bearer token — whoever still
     * has that QR is not necessarily the account holder.
     *
     * Only while `registered`. A checked-in or no-show pass is spent, and
     * handing it a working code again would undo the check-in rules.
     *
     * The registration window is deliberately NOT re-checked: they already
     * registered, and this is recovering the pass, not claiming a seat.
     */
    const code = existing.status === 'registered' ? mintRefreshToken() : null;
    const pass = code
      ? ((await repo.updatePass(db, existing.id, { passCodeHash: await hashToken(code) })) ??
        existing)
      : existing;

    const view = await repo.findById(eventId, userId);
    if (!view) throw new DomainError('EVENT_009', 'Event not found.', 404);
    return { pass: passView(pass, event, code), event: serialiseEvent(view, userId) };
  }

  if (event.status !== 'published' && event.status !== 'ongoing') {
    throw new DomainError('EVENT_007', 'Registration is closed for this event.', 422);
  }
  if (Date.now() > event.startAt.getTime() + REGISTRATION_CLOSES_MS) {
    throw new DomainError('EVENT_007', 'Registration is closed for this event.', 422);
  }

  const passCode = mintRefreshToken();
  const passCodeHash = await hashToken(passCode);

  return db.transaction(async (tx) => {
    const claimed = await repo.claimSeat(tx, eventId);
    if (!claimed) throw new DomainError('EVENT_005', 'This event is full.', 422);

    const pass = existing
      ? await repo.updatePass(tx, existing.id, {
          status: 'registered',
          passCodeHash,
          checkedInAt: null,
          checkedInBy: null,
        })
      : await repo.insertPass(tx, { eventId, userId, passCodeHash, status: 'registered' });
    if (!pass) throw new DomainError('EVENT_009', 'Event not found.', 404);

    const view = await repo.findById(eventId, userId, tx);
    if (!view) throw new DomainError('EVENT_009', 'Event not found.', 404);

    // Predefined FCM notification dispatch (asynchronous, non-blocking)
    sendPredefinedNotification(userId, 'EVENT_REMINDER', {
      eventId: String(eventId),
      eventName: event.title,
    }).catch((err) => console.error('[FCM] Event reminder push failed:', err));

    return { pass: passView(pass, claimed, passCode), event: serialiseEvent(view, userId) };
  });
}

export async function unregister(userId: number, eventId: number) {
  const pass = await repo.findPass(eventId, userId);
  if (!pass) throw new DomainError('EVENT_002', 'You are not registered for this event.', 404);
  if (pass.status === 'checked_in') {
    throw new DomainError('EVENT_007', 'You have already checked in.', 422);
  }
  if (pass.status === 'cancelled') return { cancelled: true as const };

  await db.transaction(async (tx) => {
    await repo.updatePass(tx, pass.id, { status: 'cancelled' });
    await repo.releaseSeat(tx, eventId);
  });
  return { cancelled: true as const };
}

export async function myPass(userId: number, eventId: number) {
  const [pass, event] = await Promise.all([repo.findPass(eventId, userId), repo.rawEvent(eventId)]);
  if (!event) throw new DomainError('EVENT_009', 'Event not found.', 404);
  if (!pass || pass.status === 'cancelled') {
    throw new DomainError('EVENT_002', 'You are not registered for this event.', 404);
  }
  // No passCode: it was shown once, at registration, and only a hash remains.
  return passView(pass, event, null);
}

export async function participants(userId: number, eventId: number) {
  const event = await assertHost(eventId, userId, true);
  const rows = await repo.listParticipants(eventId);
  return {
    registeredCount: event.registeredCount,
    checkedInCount: event.checkedInCount,
    capacity: event.capacity,
    items: rows.map((r) => ({
      passId: r.passId,
      user: { id: r.userId, name: r.name, avatarUrl: r.avatarUrl, city: r.city },
      email: r.email,
      status: r.status,
      registeredAt: r.registeredAt.toISOString(),
      checkedInAt: r.checkedInAt?.toISOString() ?? null,
    })),
  };
}

export async function exportParticipantsCsv(userId: number, eventId: number): Promise<string> {
  await assertHost(eventId, userId, true);
  const rows = await repo.listParticipants(eventId);

  const headers = [
    'Pass ID',
    'User ID',
    'Name',
    'Email',
    'Status',
    'Registered At',
    'Checked In At',
  ];
  const lines = [headers.join(',')];

  for (const r of rows) {
    const escape = (val: unknown) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    lines.push(
      [
        r.passId,
        r.userId,
        escape(r.name),
        escape(r.email),
        escape(r.status),
        escape(r.registeredAt.toISOString()),
        escape(r.checkedInAt ? r.checkedInAt.toISOString() : ''),
      ].join(','),
    );
  }

  return lines.join('\n');
}

/** True when this user hosts or co-hosts the event. */
async function isRunning(tx: Executor, event: repo.EventRow, userId: number) {
  if (event.hostId === userId) return true;
  const { isCoHost } = await repo.isHostOrCoHost(event.id, userId, tx);
  return isCoHost;
}

/**
 * The seven ordered checks of PRD-v2 §6.6.4.
 *
 * Order matters: the host check comes first so a stranger cannot probe which
 * pass codes exist, and the already-checked-in check comes BEFORE capacity so
 * that rescanning someone at a full event still succeeds instead of being
 * refused for a seat they already occupy.
 */
async function checkIn(
  hostId: number,
  eventId: number,
  find: (tx: Executor) => Promise<repo.PassRow | null>,
  scanClientId: string | null,
) {
  // 1. host or co-host
  const event = await assertHost(eventId, hostId, true);

  return db.transaction(async (tx) => {
    // 2. the pass exists, for THIS event
    const pass = await find(tx);
    if (!pass || pass.status === 'cancelled') {
      throw new DomainError('EVENT_002', 'No pass with that code for this event.', 404);
    }

    // 3. the event is actually running. A cancelled drive must not credit
    // attendance, and a draft has no attendees to credit.
    if (event.status !== 'published' && event.status !== 'ongoing') {
      throw new DomainError('EVENT_003', 'Check-in is not open for this event.', 422, {
        status: event.status,
      });
    }

    // ...and inside the scan window.
    const now = Date.now();
    if (
      now < event.startAt.getTime() - SCAN_OPENS_MS ||
      now > event.endAt.getTime() + SCAN_CLOSES_MS
    ) {
      throw new DomainError('EVENT_003', 'Check-in is not open for this event.', 422, {
        opensAt: new Date(event.startAt.getTime() - SCAN_OPENS_MS).toISOString(),
        closesAt: new Date(event.endAt.getTime() + SCAN_CLOSES_MS).toISOString(),
      });
    }

    const attendee = await profileRepo.findUser(pass.userId);
    const summary = {
      id: pass.userId,
      name: attendee?.name ?? 'Attendee',
      avatarUrl: attendee?.avatarUrl ?? null,
      city: attendee?.city ?? null,
    };

    // 4. already checked in is a SUCCESS that grants nothing
    if (pass.status === 'checked_in') {
      const current = await repo.rawEvent(eventId, tx);
      return {
        alreadyCheckedIn: true,
        attendee: summary,
        checkedInAt: pass.checkedInAt?.toISOString() ?? new Date().toISOString(),
        checkedInCount: current?.checkedInCount ?? event.checkedInCount,
        capacity: event.capacity,
        attendeeReward: null,
      };
    }

    // 5 & 6. claim the check-in, then the counter. Both conditional, so two
    // hosts scanning the same person at once produce exactly one of each.
    const updated = await repo.checkInPass(tx, pass.id, hostId, scanClientId);
    if (!updated) {
      throw new DomainError('EVENT_004', 'Already checked in.', 200);
    }
    const bumped = await repo.bumpCheckedIn(tx, eventId);
    if (!bumped) throw new DomainError('EVENT_005', 'This event is full.', 422);

    /**
     * 7. credit the attendee — unless the attendee is running the event.
     *
     * `[LESSON]` Without this, one account is an unbounded points machine:
     * create an event starting now, register for it, scan your own pass,
     * collect 200 points, repeat with a new event for a new pass id. The
     * host check at step 1 passes because you ARE the host, and the scan
     * window is open because you chose the start time. The same shape as
     * the goal-backdating farm, in a different module.
     *
     * The check-in itself still happens: a host who is genuinely present
     * belongs in their own participant list and counter. Only the
     * attendance REWARD is refused, because attending the thing you are
     * running is not the behaviour that reward exists to encourage.
     *
     * Verification separately gates earning, so an unverified attendee is
     * also checked in and simply earns nothing.
     */
    const runsThisEvent = await isRunning(tx, event, pass.userId);
    let attendeeReward: {
      pointsDelta: number;
      coinsDelta: number;
      reasons: { source: string; points: number; coins: number }[];
    } | null = null;
    if (attendee?.emailVerifiedAt && !runsThisEvent) {
      const result = await award(tx, {
        userId: pass.userId,
        pointsDelta: REWARDS.eventAttend.points,
        coinsDelta: REWARDS.eventAttend.coins,
        source: 'event_attend',
        sourceId: `event_attend:${pass.id}`,
        note: event.title,
      });
      if (result.awarded) {
        attendeeReward = {
          pointsDelta: REWARDS.eventAttend.points,
          coinsDelta: REWARDS.eventAttend.coins,
          reasons: [
            {
              source: 'event_attend',
              points: REWARDS.eventAttend.points,
              coins: REWARDS.eventAttend.coins,
            },
          ],
        };
      }
    }

    await maybeRewardHost(tx, event);

    return {
      alreadyCheckedIn: false,
      attendee: summary,
      checkedInAt: updated.checkedInAt?.toISOString() ?? new Date().toISOString(),
      checkedInCount: bumped.checkedInCount,
      capacity: event.capacity,
      attendeeReward,
    };
  });
}

/**
 * Pays the host once, after five distinct attendees have checked in.
 *
 * `hostRewardedAt` is claimed with a conditional UPDATE and the ledger is
 * keyed `event_host:{eventId}`, so two scans crossing the threshold at the
 * same moment still pay once.
 */
async function maybeRewardHost(tx: Executor, event: repo.EventRow) {
  if (event.hostRewardedAt) return;
  // Counts attendees who do NOT run the event. Otherwise a host plus four
  // co-hosts reaches the threshold with nobody actually attending.
  if ((await repo.checkedInAttendeeCount(tx, event.id)) < EVENT_HOST_MIN_ATTENDEES) return;
  if (!(await repo.markHostRewarded(tx, event.id))) return;

  const host = await profileRepo.findUser(event.hostId);
  if (!host?.emailVerifiedAt) return;

  await award(tx, {
    userId: event.hostId,
    pointsDelta: REWARDS.eventHost.points,
    coinsDelta: REWARDS.eventHost.coins,
    source: 'event_host',
    sourceId: `event_host:${event.id}`,
    note: event.title,
  });
}

export async function scan(
  hostId: number,
  eventId: number,
  body: { passCode: string; scanClientId: string },
) {
  const hash = await hashToken(body.passCode);
  return checkIn(
    hostId,
    eventId,
    (tx) => repo.findPassByHash(eventId, hash, tx),
    body.scanClientId,
  );
}

export async function manualCheckIn(hostId: number, eventId: number, passId: number) {
  return checkIn(hostId, eventId, (tx) => repo.findPassById(eventId, passId, tx), null);
}

export async function addCoHost(userId: number, eventId: number, coHostId: number) {
  const event = await assertHost(eventId, userId, false);
  if (coHostId === event.hostId) {
    throw new DomainError('EVENT_010', 'The host is already running this event.', 422);
  }
  if (!(await profileRepo.findUser(coHostId))) {
    throw new DomainError('EVENT_010', 'No such user.', 404);
  }
  await repo.addCoHost(eventId, coHostId);
  const view = await repo.findById(eventId, userId);
  if (!view) throw new DomainError('EVENT_009', 'Event not found.', 404);
  return serialiseEvent(view, userId);
}

export async function removeCoHost(userId: number, eventId: number, coHostId: number) {
  await assertHost(eventId, userId, false);
  await repo.removeCoHost(eventId, coHostId);
  const view = await repo.findById(eventId, userId);
  if (!view) throw new DomainError('EVENT_009', 'Event not found.', 404);
  return serialiseEvent(view, userId);
}
