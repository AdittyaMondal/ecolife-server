import { DomainError } from '@common/errors/domain-error.ts';
import { fail } from '@common/interceptors/response-envelope.ts';
import type { Context } from 'hono';

/** Maps any thrown value onto the failure envelope. */
export function errorFilter(err: Error, c: Context) {
  if (err instanceof DomainError) {
    return fail(c, err.code, err.message, err.status, err.details);
  }

  // Never leak an internal message or stack to the client.
  console.error('unhandled error:', err);
  return fail(c, 'INTERNAL_001', 'Something went wrong. Please try again.', 500);
}

export function notFoundFilter(c: Context) {
  return fail(c, 'HTTP_404', 'Route not found.', 404);
}
