import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * PRD-v2 §8 — every backend response uses one envelope.
 *   success: { status: true,  data: {...}, error: null }
 *   failure: { status: false, data: null,  error: { code, message, details } }
 */

/**
 * `details` is serialised to JSON, so it is constrained to JSON-safe values.
 * Typing it `unknown` makes `c.json()` reject the whole envelope.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type ApiError = {
  code: string;
  message: string;
  details: Record<string, JsonValue>;
};

export type Success<T> = { status: true; data: T; error: null };
export type Failure = { status: false; data: null; error: ApiError };
export type Envelope<T> = Success<T> | Failure;

/**
 * Status is a generic literal, not a widened `ContentfulStatusCode`.
 *
 * zod-openapi matches a handler's return type against the exact status codes
 * the route declares. A widened status collapses that to a union and every
 * `.openapi()` handler fails to typecheck — so the literal has to survive.
 */
export function ok<T, S extends ContentfulStatusCode = 200>(
  c: Context,
  data: T,
  status = 200 as S,
) {
  return c.json<Success<T>, S>({ status: true, data, error: null }, status);
}

export function fail<S extends ContentfulStatusCode = 400>(
  c: Context,
  code: string,
  message: string,
  status = 400 as S,
  details: Record<string, JsonValue> = {},
) {
  return c.json<Failure, S>(
    { status: false, data: null, error: { code, message, details } },
    status,
  );
}
