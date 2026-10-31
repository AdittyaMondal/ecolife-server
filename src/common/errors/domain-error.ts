import type { JsonValue } from '@common/interceptors/response-envelope.ts';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Typed domain error carrying the registry code the client reads (PRD §9.5).
 * Anything thrown that is not a DomainError is treated as a 500 and its
 * message is never forwarded to the client.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: ContentfulStatusCode = 400,
    readonly details: Record<string, JsonValue> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
