import { nullable } from '@common/openapi/envelope.ts';
import {
  rewardGrantSchema,
  userSummarySchema,
  walletSchema,
} from '@common/openapi/shared-schemas.ts';
import { z } from '@hono/zod-openapi';

/** PRD-v2 §6.6. Events, QR passes and host check-in. */

export const eventTypeSchema = z
  .enum(['plant_drive', 'cleanup_drive', 'awareness', 'recycling_drive', 'workshop', 'other'])
  .openapi({ example: 'cleanup_drive' });

export const eventStatusSchema = z
  .enum(['draft', 'published', 'ongoing', 'completed', 'cancelled'])
  .openapi({ example: 'published' });

export const eventVisibilitySchema = z
  .enum(['public', 'invite_only', 'organization_only'])
  .openapi({ example: 'public' });

export const passStatusSchema = z
  .enum(['registered', 'checked_in', 'cancelled', 'no_show'])
  .openapi({ example: 'registered' });

export const eventSchema = z
  .object({
    id: z.number().int().openapi({ example: 5 }),
    slug: z.string().openapi({ example: 'beach-cleanup-versova' }),
    title: z.string().openapi({ example: 'Beach clean-up, Versova' }),
    description: z.string().openapi({ example: 'Gloves and bags provided. Two hours, then chai.' }),
    type: eventTypeSchema,
    status: eventStatusSchema,
    visibility: eventVisibilitySchema,
    organizationId: z.number().int().nullable().optional().openapi({ example: 42 }),
    organizationName: z.string().nullable().optional().openapi({ example: 'TerraCorp' }),
    coverUrl: z.string().nullable().openapi({
      example:
        'https://images.unsplash.com/photo-1585320806297-9794b3e4eeae?auto=format&fit=crop&w=1200&q=80',
    }),
    host: userSummarySchema,
    startAt: z.string().openapi({ example: '2026-11-02T01:30:00.000Z' }),
    endAt: z.string().openapi({ example: '2026-11-02T04:00:00.000Z' }),
    venueName: z.string().openapi({ example: 'Versova Beach' }),
    venueAddress: z.string().nullable().openapi({ example: 'Versova, Andheri West, Mumbai' }),
    venueMapUrl: z.string().nullable().optional().openapi({ example: 'https://maps.google.com/?q=Versova+Beach' }),
    latitude: z.number().nullable().openapi({ example: 19.1351 }),
    longitude: z.number().nullable().openapi({ example: 72.8126 }),
    capacity: z.number().int().openapi({ example: 100 }),
    registeredCount: z.number().int().openapi({ example: 38 }),
    checkedInCount: z.number().int().openapi({ example: 0 }),
    distanceKm: z
      .number()
      .nullable()
      .optional()
      .openapi({ example: 2.4, description: 'Only when the nearby filter was used' }),
    /** Viewer-relative state, so the client renders the right CTA without a second call. */
    viewer: z
      .object({
        isHost: z.boolean().openapi({ example: false }),
        isCoHost: z.boolean().openapi({ example: false }),
        registered: z.boolean().openapi({ example: true }),
        passStatus: nullable(passStatusSchema),
      })
      .openapi('EventViewerState'),
  })
  .openapi('Event');

export const eventListQuerySchema = z.object({
  filter: z
    .enum(['upcoming', 'nearby', 'registered', 'hosting', 'past'])
    .default('upcoming')
    .openapi({ param: { name: 'filter', in: 'query' } }),
  type: eventTypeSchema.optional().openapi({ param: { name: 'type', in: 'query' } }),
  search: z.string().optional().openapi({ param: { name: 'search', in: 'query' } }),
  organizationId: z.coerce
    .number()
    .int()
    .optional()
    .openapi({ param: { name: 'organizationId', in: 'query' } }),
  lat: z.coerce
    .number()
    .optional()
    .openapi({ param: { name: 'lat', in: 'query' } }),
  lng: z.coerce
    .number()
    .optional()
    .openapi({ param: { name: 'lng', in: 'query' } }),
  radiusKm: z.coerce
    .number()
    .min(1)
    .max(200)
    .default(25)
    .openapi({
      param: { name: 'radiusKm', in: 'query' },
    }),
  cursor: z
    .string()
    .optional()
    .openapi({ param: { name: 'cursor', in: 'query' } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .openapi({
      param: { name: 'limit', in: 'query' },
    }),
});

export const createEventBodySchema = z
  .object({
    title: z.string().min(3).max(120).openapi({ example: 'Beach clean-up, Versova' }),
    description: z.string().min(10).max(4000),
    type: eventTypeSchema,
    visibility: eventVisibilitySchema.default('public'),
    organizationId: z.number().int().positive().nullable().optional(),
    coverUrl: z.string().nullable().optional(),
    startAt: z.string().openapi({ example: '2026-11-02T01:30:00.000Z' }),
    endAt: z.string().openapi({ example: '2026-11-02T04:00:00.000Z' }),
    venueName: z.string().min(2).max(160),
    venueAddress: z.string().max(400).optional(),
    venueMapUrl: z.string().max(500).nullable().optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    capacity: z.number().int().min(1).max(10_000).default(100),
    publish: z
      .boolean()
      .default(false)
      .openapi({ description: 'False leaves it as a draft, invisible to others' }),
  })
  .openapi('CreateEventBody');

/**
 * The pass. `passCode` is returned ONLY to its owner and is never stored in
 * plaintext — the database keeps a SHA-256 hash. The QR encodes
 * `ecolife://pass/{passCode}`.
 */
export const passSchema = z
  .object({
    id: z.number().int().openapi({ example: 77 }),
    eventId: z.number().int().openapi({ example: 5 }),
    eventTitle: z.string().openapi({ example: 'Beach clean-up, Versova' }),
    eventStartAt: z.string().openapi({ example: '2026-11-02T01:30:00.000Z' }),
    venueName: z.string().openapi({ example: 'Versova Beach' }),
    status: passStatusSchema,
    passCode: z
      .string()
      .openapi({ example: 'yJ8kQ2mXp...', description: 'Owner only. Encode this in the QR.' }),
    qrPayload: z.string().openapi({ example: 'ecolife://pass/yJ8kQ2mXp...' }),
    checkedInAt: z.string().nullable().openapi({ example: null }),
  })
  .openapi('EventPass');

export const participantSchema = z
  .object({
    passId: z.number().int().openapi({ example: 77 }),
    user: userSummarySchema,
    email: z.string().optional().openapi({ example: 'attendee@example.com' }),
    status: passStatusSchema,
    registeredAt: z.string().openapi({ example: '2026-10-29T12:00:00.000Z' }),
    checkedInAt: z.string().nullable().openapi({ example: null }),
  })
  .openapi('EventParticipant');

export const participantListSchema = z
  .object({
    registeredCount: z.number().int().openapi({ example: 38 }),
    checkedInCount: z.number().int().openapi({ example: 12 }),
    capacity: z.number().int().openapi({ example: 100 }),
    items: z.array(participantSchema),
  })
  .openapi('EventParticipantList');

export const scanBodySchema = z
  .object({
    passCode: z.string().min(10).openapi({ example: 'yJ8kQ2mXp...' }),
    /** Offline scanner replay key. The ledger dedupes, so a replay is a no-op. */
    scanClientId: z.string().uuid().openapi({ example: '0193f0c4-11bb-7a2e-9d31-4e5f6a7b8c9d' }),
  })
  .openapi('ScanBody');

/**
 * Returned so the scanner can show WHO just checked in. A host scanning fifty
 * people needs a face and a name, not a toast.
 *
 * `alreadyCheckedIn: true` with HTTP 200 is the idempotent path — scanning the
 * same pass twice is a success that grants nothing, never an error.
 */
export const scanResultSchema = z
  .object({
    alreadyCheckedIn: z.boolean().openapi({ example: false }),
    attendee: userSummarySchema,
    checkedInAt: z.string().openapi({ example: '2026-11-02T02:12:00.000Z' }),
    checkedInCount: z.number().int().openapi({ example: 13 }),
    capacity: z.number().int().openapi({ example: 100 }),
    attendeeReward: nullable(rewardGrantSchema).openapi({
      description: 'Null when already checked in — the reward was granted on the first scan',
    }),
  })
  .openapi('ScanResult');

export const registerResultSchema = z
  .object({ pass: passSchema, event: eventSchema })
  .openapi('RegisterResult');

export const attendResultSchema = z
  .object({ reward: rewardGrantSchema, wallet: walletSchema })
  .openapi('AttendResult');

export const coHostBodySchema = z
  .object({ userId: z.number().int().openapi({ example: 9 }) })
  .openapi('CoHostBody');
