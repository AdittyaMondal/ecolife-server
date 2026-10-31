import { DomainError } from '@common/errors/domain-error.ts';
import { z } from '@hono/zod-openapi';

/**
 * OpenAPI-aware mirror of the runtime envelope in
 * `@common/interceptors/response-envelope.ts` (PRD-v2 §8).
 *
 * Runtime shape and documented shape must not drift, so every route declares
 * its response through `jsonOk()` / `errorResponses` here and returns it
 * through `ok()` / `fail()` there.
 */

export const apiErrorSchema = z
  .object({
    code: z.string().openapi({ example: 'AUTH_001' }),
    message: z.string().openapi({ example: 'Invalid email or password.' }),
    details: z.record(z.string(), z.unknown()).openapi({ example: {} }),
  })
  .openapi('ApiError');

export const failureSchema = z
  .object({
    status: z.literal(false),
    data: z.null(),
    error: apiErrorSchema,
  })
  .openapi('Failure');

/** Wraps a payload schema in the success envelope. */
export const envelope = <T extends z.ZodType>(data: T) =>
  z.object({ status: z.literal(true), data, error: z.null() });

/** A 200 JSON response carrying `data`. */
export const jsonOk = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema: envelope(schema) } },
});

/** A non-200 JSON response carrying `error`. */
export const jsonError = (description: string) => ({
  description,
  content: { 'application/json': { schema: failureSchema } },
});

/**
 * Standard failure responses. Spread the ones a route can actually produce —
 * documenting a 409 on an endpoint that cannot conflict is a lie the clients
 * will write dead branches against.
 */
export const errorResponses = {
  400: jsonError('Validation failed'),
  401: jsonError('Not authenticated'),
  403: jsonError('Not authorised'),
  404: jsonError('Not found'),
  409: jsonError('Conflict'),
  422: jsonError('Domain rule violation'),
  429: jsonError('Rate limited — see Retry-After'),
  501: jsonError('Not implemented yet'),
} as const;

/**
 * Sprint 0: the contract exists, the behaviour does not.
 *
 * Deliberately NOT returning the schema example. Fake data in the server would
 * eventually ship. The examples live in the schemas, `openapi.json` carries
 * them, and Prism serves them on :4010 — so clients get a mock without the
 * real server ever lying about what it can do.
 */
export function notImplemented(): never {
  throw new DomainError('GEN_501', 'This endpoint is not implemented yet.', 501);
}

/** Marks a route as requiring the bearer access token. */
export const secured = [{ bearerAuth: [] }];
