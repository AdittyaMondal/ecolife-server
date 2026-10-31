import { eventHosts, eventPasses, events } from '@database/schema/index.ts';
import { hoursFromNow, type RewardRow, type Tx } from './support.ts';
import type { SeededUser } from './users.seed.ts';

/** PRD-v2 §4.2. */
const AWARD = {
  attend: { points: 200, coins: 100 },
  host: { points: 300, coins: 150 },
} as const;

/** §4.4: the host bonus needs this many distinct attendees actually scanned. */
const HOST_REWARD_MIN_CHECKINS = 5;

type EventPlan = {
  slug: string;
  title: string;
  description: string;
  type: typeof events.$inferInsert.type;
  status: typeof events.$inferInsert.status;
  visibility: typeof events.$inferInsert.visibility;
  capacity: number;
  hostEmail: string;
  coHostEmail?: string;
  startInHours: number;
  durationHours: number;
  venueName: string;
  city: string;
  latitude: number;
  longitude: number;
  /** How many passes exist. Must stay <= capacity: the database enforces it. */
  registered: number;
  checkedIn: number;
  noShow: number;
  /** A cancelled event keeps its registrations, with every pass cancelled. */
  passesCancelled?: true;
  flagged?: true;
};

/**
 * Six events covering all five lifecycle states (PRD-v2 §6.6), plus the two
 * states that break a naive events list: one at exactly capacity, and one
 * invite-only.
 *
 * `registered` and `checkedIn` here are the number of PASSES written, and the
 * denormalised counters on `events` are then set from the passes rather than
 * typed in. v1 had a counter column only a seeder ever updated, so it was
 * permanently stale — and `events_checkins_within_registrations` now rejects
 * the mismatch outright.
 */
const EVENTS: readonly EventPlan[] = [
  {
    slug: 'terrace-composting-workshop',
    title: 'Terrace Composting Workshop',
    description:
      'Two hours on building a working compost bin from a terracotta pot, what goes in, ' +
      'what never does, and how to fix a bin that smells.',
    type: 'workshop',
    status: 'draft',
    visibility: 'public',
    capacity: 30,
    hostEmail: 'meera.nair@ecolife.app',
    startInHours: 24 * 14,
    durationHours: 2,
    venueName: 'Panampilly Community Hall',
    city: 'Kochi',
    latitude: 9.9654,
    longitude: 76.2895,
    registered: 0,
    checkedIn: 0,
    noShow: 0,
  },
  {
    slug: 'versova-beach-cleanup',
    title: 'Versova Beach Clean-up',
    description:
      'Monthly clean-up of the north stretch. Gloves, sacks and weighing scales provided; ' +
      'bring a refillable bottle and closed shoes.',
    type: 'cleanup_drive',
    status: 'published',
    visibility: 'public',
    capacity: 60,
    hostEmail: 'dev@ecolife.app',
    coHostEmail: 'aarav.sharma@ecolife.app',
    startInHours: 24 * 5,
    durationHours: 4,
    venueName: 'Versova Beach, Gate 3',
    city: 'Mumbai',
    latitude: 19.1366,
    longitude: 72.8128,
    registered: 20,
    checkedIn: 0,
    noShow: 0,
  },
  {
    slug: 'cubbon-park-plant-drive',
    title: 'Cubbon Park Plant Drive',
    description:
      'Planting 200 native saplings along the eastern path with the horticulture ' +
      'department. Scanning is open at the bandstand.',
    type: 'plant_drive',
    status: 'ongoing',
    visibility: 'public',
    capacity: 40,
    hostEmail: 'isha.verma@ecolife.app',
    startInHours: -1,
    durationHours: 4,
    venueName: 'Cubbon Park, Bandstand',
    city: 'Bengaluru',
    latitude: 12.9763,
    longitude: 77.5929,
    registered: 18,
    checkedIn: 11,
    noShow: 0,
    // Check-ins ran well past this host's median, so §4.4 flags it for an
    // admin to look at. The awards are still granted — flagging is not a hold.
    flagged: true,
  },
  {
    slug: 'powai-lake-cleanup',
    title: 'Powai Lake Clean-up',
    description:
      'Shoreline clean-up and waste audit. 412 kg collected, of which 198 kg went to ' +
      'recyclers rather than landfill.',
    type: 'cleanup_drive',
    status: 'completed',
    visibility: 'public',
    capacity: 30,
    hostEmail: 'advait.bose@ecolife.app',
    coHostEmail: 'vivaan.patel@ecolife.app',
    startInHours: -24 * 8,
    durationHours: 4,
    venueName: 'Powai Lake Promenade',
    city: 'Mumbai',
    latitude: 19.1273,
    longitude: 72.9048,
    registered: 22,
    checkedIn: 17,
    noShow: 5,
  },
  {
    slug: 'ewaste-collection-drive',
    title: 'E-waste Collection Drive',
    description:
      'Cancelled: the certified recycler withdrew two days out. Registrations are kept so ' +
      'everyone can be notified when it is rescheduled.',
    type: 'recycling_drive',
    status: 'cancelled',
    visibility: 'public',
    capacity: 80,
    hostEmail: 'kabir.singh@ecolife.app',
    startInHours: 24 * 3,
    durationHours: 5,
    venueName: 'Sector 29 Community Centre',
    city: 'Gurugram',
    latitude: 28.4668,
    longitude: 77.0624,
    registered: 14,
    checkedIn: 0,
    noShow: 0,
    passesCancelled: true,
  },
  {
    slug: 'balcony-garden-starter',
    title: 'Balcony Garden Starter Workshop',
    description:
      'Twelve seats, each with a pot, soil mix and three seedlings to take home. ' +
      'Full — the waitlist opens if someone cancels.',
    type: 'workshop',
    status: 'published',
    visibility: 'invite_only',
    capacity: 12,
    hostEmail: 'anika.pillai@ecolife.app',
    startInHours: 24 * 9,
    durationHours: 3,
    venueName: 'Kowdiar Rooftop Studio',
    city: 'Thiruvananthapuram',
    latitude: 8.5165,
    longitude: 76.9672,
    // Exactly at capacity: registered_count = capacity is legal, one more is not.
    registered: 12,
    checkedIn: 0,
    noShow: 0,
  },
];

const sha256 = (input: string) => new Bun.CryptoHasher('sha256').update(input).digest('hex');

/**
 * Events, their co-hosts, and a pass per registration.
 *
 * Only a SHA-256 of each pass code is stored: the plaintext is shown to its
 * owner once and encoded into the QR, so a database leak cannot be turned into
 * a wallet of valid passes. The seed therefore mints codes it immediately
 * forgets — nothing here can be scanned, which is the correct trade and worth
 * knowing before someone goes looking for a test QR.
 */
const EVENT_COVERS: Record<string, string> = {
  'terrace-composting-workshop':
    'https://images.unsplash.com/photo-1585320806297-9794b3e4eeae?auto=format&fit=crop&w=1200&q=80',
  'versova-beach-cleanup':
    'https://images.unsplash.com/photo-1618477461853-cf6ed80faba5?auto=format&fit=crop&w=1200&q=80',
  'cubbon-park-plant-drive':
    'https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?auto=format&fit=crop&w=1200&q=80',
  'powai-lake-cleanup':
    'https://images.unsplash.com/photo-1532996122724-e3c354a0b15b?auto=format&fit=crop&w=1200&q=80',
  'ewaste-collection-drive':
    'https://images.unsplash.com/photo-1550751827-4bd374c3f58b?auto=format&fit=crop&w=1200&q=80',
  'balcony-garden-starter':
    'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?auto=format&fit=crop&w=1200&q=80',
};

export async function seedEvents(
  tx: Tx,
  seeded: readonly SeededUser[],
): Promise<{ events: number; hosts: number; passes: number; rewards: RewardRow[] }> {
  const codeSalt = crypto.randomUUID();
  const byEmail = (email: string) => {
    const user = seeded.find((s) => s.email === email);
    if (!user) throw new Error(`event host ${email} was not seeded`);
    return user;
  };

  const written = await tx
    .insert(events)
    .values(
      EVENTS.map((e) => ({
        slug: e.slug,
        title: e.title,
        description: e.description,
        type: e.type,
        status: e.status,
        visibility: e.visibility,
        coverUrl:
          EVENT_COVERS[e.slug] ??
          'https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?auto=format&fit=crop&w=1200&q=80',
        hostId: byEmail(e.hostEmail).id,
        startAt: hoursFromNow(e.startInHours),
        endAt: hoursFromNow(e.startInHours + e.durationHours),
        venueName: e.venueName,
        venueAddress: `${e.venueName}, ${e.city}`,
        latitude: e.latitude,
        longitude: e.longitude,
        capacity: e.capacity,
        registeredCount: e.registered,
        checkedInCount: e.checkedIn,
        flaggedForReview: e.flagged ?? false,
        hostRewardedAt:
          e.status === 'completed' && e.checkedIn >= HOST_REWARD_MIN_CHECKINS
            ? hoursFromNow(e.startInHours + e.durationHours + 1)
            : null,
        createdAt: hoursFromNow(e.startInHours - 24 * 21),
      })),
    )
    .returning({ id: events.id, slug: events.slug });

  const idBySlug = new Map(written.map((row) => [row.slug, row.id]));

  const hostRows: (typeof eventHosts.$inferInsert)[] = [];
  const passRows: (typeof eventPasses.$inferInsert)[] = [];
  const rewards: RewardRow[] = [];

  for (const [index, plan] of EVENTS.entries()) {
    const eventId = idBySlug.get(plan.slug);
    if (eventId === undefined) throw new Error(`event ${plan.slug} was not inserted`);
    const host = byEmail(plan.hostEmail);

    hostRows.push({ eventId, userId: host.id, role: 'host' });
    if (plan.coHostEmail) {
      hostRows.push({ eventId, userId: byEmail(plan.coHostEmail).id, role: 'co_host' });
    }

    // Distinct attendees, rotated by event so the six guest lists differ.
    // event_pass_user_unq means one pass per (event, user), which also caps
    // registrations at the number of seeded users.
    //
    // Only users who finished onboarding: every tab redirects to the wizard
    // until then (§3.2), so an unonboarded account holding an event pass is a
    // state the product cannot actually reach.
    const candidates = seeded.filter((s) => s.id !== host.id && s.baseline !== null);
    if (plan.registered > candidates.length) {
      throw new Error(`${plan.slug} wants ${plan.registered} attendees, only ${candidates.length}`);
    }
    const attendees = Array.from(
      { length: plan.registered },
      (_, i) => candidates[(i + index * 5) % candidates.length],
    ).filter((u): u is SeededUser => u !== undefined);

    const endedAt = plan.startInHours + plan.durationHours;
    attendees.forEach((attendee, position) => {
      const checkedIn = !plan.passesCancelled && position < plan.checkedIn;
      const noShow = !plan.passesCancelled && !checkedIn && position < plan.checkedIn + plan.noShow;

      passRows.push({
        eventId,
        userId: attendee.id,
        passCodeHash: sha256(`${codeSalt}:${plan.slug}:${attendee.id}`),
        status: plan.passesCancelled
          ? 'cancelled'
          : checkedIn
            ? 'checked_in'
            : noShow
              ? 'no_show'
              : 'registered',
        registeredAt: hoursFromNow(plan.startInHours - 24 * 5),
        checkedInAt: checkedIn ? hoursFromNow(plan.startInHours + 0.5) : null,
        checkedInBy: checkedIn ? host.id : null,
        scanClientId: checkedIn ? crypto.randomUUID() : null,
      });
    });

    if (
      plan.checkedIn >= HOST_REWARD_MIN_CHECKINS &&
      plan.status === 'completed' &&
      host.verified
    ) {
      rewards.push({
        userId: host.id,
        pointsDelta: AWARD.host.points,
        coinsDelta: AWARD.host.coins,
        source: 'event_host',
        sourceId: `event_host:${eventId}`,
        note: `${plan.checkedIn} attendees checked in`,
        createdAt: hoursFromNow(endedAt + 1),
      });
    }
  }

  await tx.insert(eventHosts).values(hostRows);

  const writtenPasses = await tx.insert(eventPasses).values(passRows).returning({
    id: eventPasses.id,
    userId: eventPasses.userId,
    status: eventPasses.status,
    checkedInAt: eventPasses.checkedInAt,
  });

  const verified = new Set(seeded.filter((s) => s.verified).map((s) => s.id));
  for (const pass of writtenPasses) {
    // §4.4: the pass credits its OWNER, so a shared screenshot earns the
    // sharer nothing. And an unverified account earns nothing at all.
    if (pass.status !== 'checked_in' || !verified.has(pass.userId)) continue;
    rewards.push({
      userId: pass.userId,
      pointsDelta: AWARD.attend.points,
      coinsDelta: AWARD.attend.coins,
      source: 'event_attend',
      sourceId: `event_attend:${pass.id}`,
      createdAt: pass.checkedInAt ?? undefined,
    });
  }

  return {
    events: written.length,
    hosts: hostRows.length,
    passes: writtenPasses.length,
    rewards,
  };
}
