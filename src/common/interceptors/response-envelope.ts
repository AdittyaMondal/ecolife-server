import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * PRD §9.5 — every backend response uses one envelope.
 *   success: { status: true,  data: {...}, error: null }
 *   failure: { status: false, data: null,  error: { code, message, details } }
 */
export type ApiError = {
  code: string;
  message: string;
  details: Record<string, unknown>;
};

export type Envelope<T> =
  | { status: true; data: T; error: null }
  | { status: false; data: null; error: ApiError };

export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
  return c.json<Envelope<T>>({ status: true, data, error: null }, status);
}

export function fail(
  c: Context,
  code: string,
  message: string,
  status: ContentfulStatusCode = 400,
  details: Record<string, unknown> = {},
) {
  return c.json<Envelope<never>>(
    { status: false, data: null, error: { code, message, details } },
    status,
  );
}
