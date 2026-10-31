import { z } from '@hono/zod-openapi';

/** Seeded reference data and the public methodology table. */

export const citySchema = z
  .object({
    id: z.number().int().openapi({ example: 1 }),
    name: z.string().openapi({ example: 'Mumbai' }),
    regionCode: z.string().openapi({ example: 'IN-MH' }),
  })
  .openapi('City');

export const regionSchema = z
  .object({
    code: z.string().openapi({ example: 'IN-MH' }),
    name: z.string().openapi({ example: 'Maharashtra' }),
    gridKgPerKwh: z.number().openapi({ example: 0.71 }),
    tariffPaisePerKwh: z.number().int().openapi({ example: 950 }),
  })
  .openapi('Region');

export const factorSchema = z
  .object({
    key: z.string().openapi({ example: 'transport.car_petrol' }),
    value: z.number().openapi({ example: 0.171 }),
    unit: z.string().openapi({ example: 'kg CO2e/km' }),
    basis: z.string().openapi({ example: '13.5 km/l x 2.31 kg CO2/l petrol' }),
    source: z.string().openapi({ example: 'IPCC default + Indian fleet average' }),
  })
  .openapi('EmissionFactor');

/**
 * Public and uncached-sensitive. Every number the app shows a user is traceable
 * to a row here — "where does 0.71 come from?" has an answer in the product,
 * not in a conversation.
 */
export const methodologySchema = z
  .object({
    factorVersion: z.number().int().openapi({ example: 1 }),
    updatedAt: z.string().openapi({ example: '2026-10-31T00:00:00.000Z' }),
    caveat: z.string().openapi({
      example:
        'Published averages, not measurements. India-weighted where India-specific data exists.',
    }),
    factors: z.array(factorSchema),
  })
  .openapi('Methodology');

export const presignBodySchema = z
  .object({
    purpose: z.enum(['avatar', 'event_cover']).openapi({ example: 'event_cover' }),
    contentType: z
      .enum(['image/jpeg', 'image/png', 'image/webp'])
      .openapi({ example: 'image/jpeg' }),
    sizeBytes: z.number().int().min(1).max(5_242_880).openapi({ example: 840_122 }),
  })
  .openapi('PresignBody');

export const presignResultSchema = z
  .object({
    uploadUrl: z.string().openapi({ example: 'https://storage.example.com/...' }),
    publicUrl: z.string().openapi({ example: 'https://cdn.ecolife.app/covers/abc123.webp' }),
    expiresInSeconds: z.number().int().openapi({ example: 300 }),
  })
  .openapi('PresignResult');

export const notificationSchema = z
  .object({
    id: z.number().int().openapi({ example: 44 }),
    type: z.string().openapi({ example: 'event_reminder' }),
    title: z.string().openapi({ example: 'Beach clean-up tomorrow, 7 AM' }),
    body: z.string().nullable().openapi({ example: 'Your pass is ready.' }),
    linkPath: z.string().nullable().openapi({ example: '/events/beach-cleanup-versova' }),
    readAt: z.string().nullable().openapi({ example: null }),
    createdAt: z.string().openapi({ example: '2026-10-31T08:00:00.000Z' }),
  })
  .openapi('Notification');
