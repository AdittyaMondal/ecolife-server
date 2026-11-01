import { z } from '@hono/zod-openapi';

/** Shared parameter and pagination primitives (PRD-v2 §8). */

export const idParam = z.object({
  id: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'id', in: 'path' }, example: 42 }),
});

/**
 * A `{slug}` path parameter.
 *
 * `example` is required, because the examples in this document ARE the mock
 * both clients develop against and the value anyone exploring /docs will
 * send first. A shared example cannot be right for two namespaces: the same
 * string was previously offered for events and for products, so trying
 * either produced a confusing 404 against a perfectly working endpoint.
 * Pass a slug the seed actually creates.
 */
export const slugParam = (example: string) =>
  z.object({
    slug: z
      .string()
      .min(1)
      .openapi({ param: { name: 'slug', in: 'path' }, example }),
  });

/** Keyset pagination. A cursor is opaque to the client by design. */
export const cursorQuery = z.object({
  cursor: z
    .string()
    .optional()
    .openapi({ param: { name: 'cursor', in: 'query' } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .openapi({
      param: { name: 'limit', in: 'query' },
      example: 20,
    }),
});

export const pageInfoSchema = z
  .object({
    nextCursor: z.string().nullable().openapi({ example: null }),
    hasMore: z.boolean().openapi({ example: false }),
  })
  .openapi('PageInfo');

/** `{ items, pageInfo }` — the shape every list endpoint returns. */
export const paginated = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), pageInfo: pageInfoSchema });

export const dateString = (example: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
    .openapi({ example });

/**
 * `x-ecolife-platform` — the one signal that decides how the refresh token is
 * delivered (PRD-v2 §6.1).
 *
 * `ios` / `android` get the token in the response body for expo-secure-store.
 * Anything else, including a missing header, is treated as a browser and gets
 * an httpOnly cookie instead, with `session.refreshToken: null` in the body —
 * returning a 30-day credential to JS would hand any XSS the whole account.
 *
 * It is declared here rather than only read in the handler because it was
 * invisible in the contract: a mobile client that guessed `X-Client: mobile`,
 * or sent nothing, got `null` and no way to find out why.
 */
export const platformHeader = z.object({
  'x-ecolife-platform': z
    .enum(['ios', 'android', 'web'])
    .optional()
    .openapi({
      param: { name: 'x-ecolife-platform', in: 'header', required: false },
      example: 'android',
      description:
        'Send ios or android to receive session.refreshToken in the response body. ' +
        'Omitted or web: the token is set as an httpOnly cookie and the body field is null.',
    }),
});
